"""Conservative closed-balloon recovery and stationary texture patch repair.

No network/model calls. Only the supplied OCR word neighbourhoods are erased.
This is classical image processing, not learned/general-purpose inpainting.
"""
import cv2
import numpy as np
from PIL import Image,ImageDraw
from scipy import ndimage as ndi

def polygon_mask(size,words,padding=0):
    image=Image.new('L',size);draw=ImageDraw.Draw(image)
    for word in words:
        points=[(v.get('x',0),v.get('y',0)) for v in word['boundingBox']['vertices']]
        draw.polygon(points,fill=255)
    result=np.asarray(image)>0
    if padding:
        result=ndi.binary_dilation(result,iterations=padding)
    return result

class BalloonRecovery:
    def __init__(self,image,segments,words):
        self.image=image
        self.original=np.asarray(image)
        self.gray=np.asarray(image.convert('L'))
        self.structure_gray=ndi.median_filter(self.gray,size=3)
        self.segments=segments
        self.words=words
        self.contours=[]
        self.all_text=np.zeros(self.gray.shape,bool)
        for segment in segments:
            self.all_text|=polygon_mask(image.size,[words[i] for i in segment['source_word_ids']],padding=7)
        for threshold in (80,120,160,200,235):
            binary=(self.gray<threshold).astype('uint8')*255
            for kernel in (1,2,3):
                work=binary if kernel==1 else cv2.morphologyEx(binary,cv2.MORPH_CLOSE,np.ones((kernel,kernel),'uint8'))
                contours,_=cv2.findContours(work,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
                for contour in contours:
                    area=cv2.contourArea(contour)
                    if 300<area<self.gray.size*.4:
                        a,b,w,h=cv2.boundingRect(contour)
                        if w>=20 and h>=20:
                            self.contours.append((contour,area,(a,b,a+w,b+h)))

    def interiors(self,segment):
        a,b,c,d=map(int,segment['placement_box'])
        W,H=self.image.size
        box_area=max(1,(c-a)*(d-b))
        xa,ya,xc,yd=segment['word_box']
        text_area=max(1,(xc-xa)*(yd-ya))
        centers=[]
        for word_id in segment['source_word_ids']:
            points=self.words[word_id]['boundingBox']['vertices']
            centers.append((sum(v.get('x',0) for v in points)/4,sum(v.get('y',0) for v in points)/4))
        candidates=[]
        for contour,area,(x0,y0,x1,y1) in self.contours:
            if area<text_area*.95 or area>box_area*4.5:
                continue
            overlap=max(0,min(c,x1)-max(a,x0))*max(0,min(d,y1)-max(b,y0))/box_area
            if overlap<.5:
                continue
            coverage=sum(cv2.pointPolygonTest(contour,p,False)>=0 for p in centers)/len(centers)
            if coverage<1.0:
                continue
            occupancy=area/max(1,(x1-x0)*(y1-y0))
            if segment['kind']=='free_text' and ((x1-x0)/max(1,y1-y0)<2 or occupancy<.8):
                continue
            if segment['kind']=='unassigned' and area<text_area*2:
                continue
            score=overlap*3+coverage*2+occupancy*.3-min(area/box_area,4)*.15
            candidates.append((score,contour))
        if not candidates:
            raise ValueError('No closed balloon/caption enclosing the source text')
        selected=[self.words[i] for i in segment['source_word_ids']]
        boundary_text=polygon_mask(self.image.size,selected,padding=4)
        seen=set()
        for score,contour in sorted(candidates,key=lambda x:x[0],reverse=True):
            points=contour.reshape(-1,2)
            keep=~boundary_text[points[:,1],points[:,0]]
            # Interpolate boundary intrusions made by letters touching a rim.
            if np.count_nonzero(keep)>=4 and np.mean(keep)>.35:
                contour=points[keep].reshape(-1,1,2)
            interior=np.zeros(self.gray.shape,'uint8')
            cv2.fillPoly(interior,[contour],255)
            interior=ndi.binary_erosion(interior>0,iterations=3)
            bounds=[max(0,a-10),max(0,b-10),min(W,c+10),min(H,d+10)]
            limit=np.zeros_like(interior)
            limit[bounds[1]:bounds[3],bounds[0]:bounds[2]]=True
            interior&=limit
            if np.count_nonzero(interior)<150:
                continue
            key=np.packbits(interior).tobytes()
            if key in seen:
                continue
            seen.add(key)
            yield interior,bounds

    def interior(self,segment):
        return next(self.interiors(segment))

    def background(self,interior):
        samples=interior & ~self.all_text
        if samples.sum()<100:
            raise ValueError('Too little text-free interior for a background estimate')
        values=self.gray[samples]
        q10,median,q90=np.percentile(values,[10,50,90])
        white_fraction=float(np.mean(values>=240))
        if white_fraction>=.9 and median>=248:
            return np.full_like(self.original,255),{'method':'closed_white_balloon','background_median':float(median),'sample_pixels':int(samples.sum())}
        if q90-q10<3 and median>=150:
            # Only genuinely flat tones may be filled uniformly. RGB medians
            # retain paper tint instead of inserting a neutral gray rectangle.
            color=np.median(self.original[samples],axis=0).round().astype('uint8')
            return np.broadcast_to(color,self.original.shape).copy(),{'method':'flat_tone_balloon','background_median':float(median),'sample_pixels':int(samples.sum())}
        if median>225:
            raise ValueError('Mostly white region with unresolved linework; texture synthesis withheld')
        if median<145 or q90-q10>115:
            raise ValueError('Interior is too dark or nonstationary for texture patch repair')
        # Do not synthesize over long dark strokes such as hair or frame lines.
        core=ndi.binary_erosion(interior,iterations=4)&~self.all_text
        labels,_=ndi.label((self.structure_gray<145)&core)
        for label,sl in enumerate(ndi.find_objects(labels),1):
            if sl is None:continue
            height=sl[0].stop-sl[0].start;width=sl[1].stop-sl[1].start
            area=int((labels[sl]==label).sum())
            if area>=12 and max(width,height)>=14:
                raise ValueError('Nonstationary dark linework inside gray region; patch repair withheld')
        # Find a complete text-free patch with matching tone and variation.
        expected_mean=float(np.mean(values));expected_std=float(np.std(values))
        valid=None
        for size in (25,21,17,13,9):
            locations=ndi.minimum_filter(samples.astype('uint8'),size=size,mode='constant',cval=0)>0
            yy,xx=np.where(locations)
            if len(xx)<3:
                continue
            averages=ndi.uniform_filter(self.gray.astype('float32'),size=size)
            squares=ndi.uniform_filter(self.gray.astype('float32')**2,size=size)
            spread=np.sqrt(np.maximum(0,squares-averages**2))
            costs=np.abs(averages[yy,xx]-expected_mean)+np.abs(spread[yy,xx]-expected_std)*.5
            order=np.argsort(costs)
            for index in order:
                if costs[index]>25:
                    break
                y,x=int(yy[index]),int(xx[index]);radius=size//2
                patch=self.original[y-radius:y+radius+1,x-radius:x+radius+1]
                valid=(patch,x-radius,y-radius,size)
                break
            if valid:
                break
        if valid is None:
            raise ValueError('No suitable clean background patch found')
        patch,px,py,size=valid
        H,W=self.gray.shape
        # Deterministic reflected tiling prevents a hard discontinuity per tile.
        reflected=np.concatenate((patch,patch[:,::-1]),axis=1)
        reflected=np.concatenate((reflected,reflected[::-1]),axis=0)
        tiled=np.tile(reflected,(H//reflected.shape[0]+2,W//reflected.shape[1]+2,1))[:H,:W]
        return tiled,{'method':'sampled_gray_texture','background_median':float(median),
                      'sample_pixels':int(samples.sum()),'patch_box':[px,py,px+size,py+size],
                      'limitation':'Stationary patch synthesis; not a learned reconstruction of the original texture.'}

    def prepare(self,segment):
        last_error='No suitable closed interior'
        gray_candidates=[]
        chosen=None
        # Prefer a verified white interior over an outer contour containing raster.
        for interior,bounds in self.interiors(segment):
            samples=interior&~self.all_text
            values=self.gray[samples]
            if len(values)<100:
                continue
            median=np.median(values)
            if np.mean(values>=240)>=.9 and median>=248:
                replacement,details=self.background(interior)
                chosen=(interior,bounds,replacement,details)
                break
            gray_candidates.append((interior,bounds))
        if chosen is None:
            for interior,bounds in gray_candidates:
                try:
                    replacement,details=self.background(interior)
                    chosen=(interior,bounds,replacement,details)
                    break
                except ValueError as error:
                    last_error=str(error)
        if chosen is None:
            raise ValueError(last_error)
        interior,bounds,replacement,details=chosen
        selected=[self.words[i] for i in segment['source_word_ids']]
        margin=max(5,min(12,round(np.median([abs(w['boundingBox']['vertices'][3].get('y',0)-w['boundingBox']['vertices'][0].get('y',0)) for w in selected])*.22)))
        mask=polygon_mask(self.image.size,selected,padding=margin)&interior
        # Protect every other source region even when detectors overlap.
        safe=interior.copy()
        for other in self.segments:
            if other['id']==segment['id']:
                continue
            foreign=polygon_mask(self.image.size,[self.words[i] for i in other['source_word_ids']],padding=4)
            mask&=~foreign;safe&=~foreign
        if mask.sum()<20:
            raise ValueError('No safe source text neighbourhood to clean')
        if details['method']=='closed_white_balloon':
            core=ndi.binary_erosion(safe,iterations=4)&~mask
            labels,_=ndi.label((self.gray<150)&core)
            for label,sl in enumerate(ndi.find_objects(labels),1):
                if sl is None:continue
                height=sl[0].stop-sl[0].start;width=sl[1].stop-sl[1].start
                area=int((labels[sl]==label).sum())
                if area>=12 and max(width,height)>=8:
                    raise ValueError('Unrecognized ink remains inside white balloon; source verification required')
        a,b,c,d=bounds
        details.update({'interior_pixels':int(interior.sum()),'erase_pixels':int(mask.sum()),
                        'scope':'Only source word neighbourhoods inside the recovered closed region'})
        return mask,replacement,safe[b:d,a:c],bounds,details

def retained_ellipsis(image,safe,bounds,mask,segment):
    """Recognize a small horizontal three-dot mark missed by OCR in a white balloon.

    Does not infer language or remove the mark. The caller reserves these pixels.
    """
    a,b,c,d=bounds
    inner=ndi.binary_erosion(safe,iterations=4)
    gray=np.asarray(image.convert('L'))[b:d,a:c]
    labels,_=ndi.label((gray<150)&inner&~mask[b:d,a:c])
    xa,ya,xc,yd=segment['word_box'];height=max(1,yd-ya)
    dots=[]
    for i,sl in enumerate(ndi.find_objects(labels),1):
        if sl is None:
            continue
        sy,sx=sl;h=sy.stop-sy.start;w=sx.stop-sx.start
        area=int((labels[sl]==i).sum());x=(sx.start+sx.stop)/2+a;y=(sy.start+sy.stop)/2+b
        if 2<=area<=100 and w<=12 and h<=12 and xa-10<=x<=xc+10 and yd+2<=y<=yd+max(60,height*3):
            dots.append((x,y,area,(sx.start+a,sy.start+b,sx.stop+a,sy.stop+b)))
    dots.sort()
    for p,q,r in zip(dots,dots[1:],dots[2:]):
        gaps=[q[0]-p[0],r[0]-q[0]]
        if min(gaps)<1 or max(gaps)>12 or max(gaps)/min(gaps)>2:
            continue
        if max(x[1] for x in (p,q,r))-min(x[1] for x in (p,q,r))>2:
            continue
        if max(x[2] for x in (p,q,r))/min(x[2] for x in (p,q,r))>4:
            continue
        return [min(x[3][0] for x in (p,q,r)),min(x[3][1] for x in (p,q,r)),
                max(x[3][2] for x in (p,q,r)),max(x[3][3] for x in (p,q,r))]
    return None
