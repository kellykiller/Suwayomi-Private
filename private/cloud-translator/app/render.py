"""Automatic page renderer with bounded cleanup, fit fallbacks and pixel checks."""
from pathlib import Path
import re
import numpy as np,cv2
from PIL import Image
from scipy import ndimage as ndi
import layout_core as engine
from balloon_cleanup import BalloonRecovery,polygon_mask,retained_ellipsis
from paper_regions import PaperRecovery

APP=Path(__file__).resolve().parent
RENDERER_VERSION='0.2.4'

def letters(text):return ''.join(c for c in (text or '').casefold() if c.isalnum())

def augment_missing_ink(image,mask,selected,segment,segments,append_line=False,verified_box=None):
 gray=np.asarray(image.convert('L'));labels,_=ndi.label(gray<200)
 allowed=np.zeros(gray.shape,bool);W,H=image.size
 for w in selected:
  pts=engine.vertices(w);xa=min(x for x,y in pts);xc=max(x for x,y in pts);ya=min(y for x,y in pts);yd=max(y for x,y in pts)
  gap=max(8,min(40,int((yd-ya)*1.5)))
  a,b,c,d=map(int,segment['placement_box']);a=max(a,xa-gap,0);c=min(c,xc+gap,W);b=max(b,ya-6,0);d=min(d,yd+6,H)
  allowed[b:d,a:c]=True
 if verified_box is not None:
  a,b,c,d=map(int,verified_box);allowed[max(0,b):min(H,d+1),max(0,a):min(W,c+1)]=True
 if append_line:
  # An image-verified suffix can continue on the next line outside the OCR box.
  # Search one line below, reject components crossing the boundary, and protect
  # all separately assigned regions. Do not grow the erasure to a rectangle.
  heights=[max(y for x,y in engine.vertices(w))-min(y for x,y in engine.vertices(w)) for w in selected]
  h=max(8,float(np.median(heights)));a,b,c,d=map(int,segment['word_box'])
  allowed[max(0,d-4):min(H,d+int(h*1.5)+6),max(0,a-6):min(W,c+6)]=True
 ids=np.unique(labels[allowed]);ids=ids[ids!=0]
 outside_ids=np.unique(labels[~allowed]);ids=ids[~np.isin(ids,outside_ids)]
 extra=np.isin(labels,ids)
 for other in segments:
  if other['id']==segment['id']:continue
  xa,ya,xc,yd=map(int,other['word_box']);extra[max(0,ya-3):min(H,yd+3),max(0,xa-3):min(W,xc+3)]=False
 return mask|extra|(ndi.binary_dilation(extra,iterations=1)&(gray>=200))

def fallback_inpaint(image,segment,selected,segments,mask,expand_mask=False):
 original=np.asarray(image);H,W=original.shape[:2]
 # Repair only OCR glyph neighbourhoods, never a whole balloon or panel.
 erase=mask|polygon_mask(image.size,selected,padding=3)
 xa,ya,xc,yd=map(int,segment['word_box'])
 ys,xs=np.where(mask)
 if expand_mask and len(xs):xa=min(xa,int(xs.min()));ya=min(ya,int(ys.min()));xc=max(xc,int(xs.max())+1);yd=max(yd,int(ys.max())+1)
 a=max(0,xa-10);b=max(0,ya-10);c=min(W,xc+10);d=min(H,yd+10)
 if (c-a)<16 or (d-b)<16:raise ValueError('Textbereich zu klein fuer den Satz.')
 limit=np.zeros((H,W),bool);limit[b:d,a:c]=True;erase&=limit
 safe=np.ones((d-b,c-a),bool);safe[:3]=False;safe[-3:]=False;safe[:,:3]=False;safe[:,-3:]=False
 for other in segments:
  if other['id']==segment['id']:continue
  x,y,z,v=map(int,other['word_box']);x=max(a,x-4);y=max(b,y-4);z=min(c,z+4);v=min(d,v+4)
  if x<z and y<v:safe[y-b:v-b,x-a:z-a]=False;erase[y:v,x:z]=False
 if not erase.any():raise ValueError('Keine begrenzte Loeschmaske.')
 repaired=cv2.inpaint(original,erase.astype('uint8')*255,3,cv2.INPAINT_TELEA)
 return erase,repaired,safe,[a,b,c,d]

def render_page(page,groups,words,translations,dest):
 image=Image.open(page['path']).convert('RGB');original=np.array(image);H,W=original.shape[:2]
 segments=[{'id':g['id'],'kind':g['kind'],'placement_box':list(map(int,g['box'])),'word_box':g.get('verified_source_box') or g['text_box'],'source_word_ids':[w['id'] for w in g['words']]} for g in groups]
 records=[];successful=[];glyph_union=np.zeros((H,W),bool);recovery=None;paper=None
 # Protect every other source region, including preserved effects and punctuation.
 for group,segment in zip(groups,segments,strict=True):
  sid=group['id'];entry=translations.get(sid,{});target=entry.get('text');selected=[words[i] for i in segment['source_word_ids']]
  rec={'id':sid,'source':group['text'],'effective_source':group.get('effective_source',group['text']),
       'target':target,'member_ids':group.get('member_ids',[sid]),'classification':group.get('review',{}),'status':'retained_source','method':None,
       'exception_case':group.get('exception_case'),'unit_word_ids':group.get('unit_word_ids')}
  records.append(rec)
  if group.get('disposition')!='translate':rec['status']=group.get('disposition','retained_unresolved');continue
  if not target:rec['reason']='Keine verlaessliche Uebersetzung vorhanden.';continue
  if re.sub(r'\s+','',target.upper())==re.sub(r'\s+','',group['text'].upper()):rec['status']='retained_equivalent';continue
  mask,score,details=engine.complete_text_mask(image,selected)
  verified_box=group.get('verified_source_box')
  signature=lambda text:''.join((text or '').casefold().split())
  mismatch=letters(group['text'])!=letters(group.get('effective_source',group['text'])) or (verified_box is not None and signature(group['text'])!=signature(group.get('effective_source',group['text'])))
  if mismatch and group.get('review_origin') in ('live_api','job_cache','imported_live_review','grouped_reviews','complete_bubble_api'):
   old=letters(group['text']);new=letters(group['effective_source'])
   mask=augment_missing_ink(image,mask,selected,segment,segments,append_line=bool(old) and new.startswith(old) and len(new)>len(old),verified_box=verified_box)
  attempts=[]
  if details['safe'] and score>=.85:
   clean=original.copy();clean[mask]=255
   try:
    safe,bounds=engine.white_interior(clean,segment,mask,segments);attempts.append((mask,None,safe,bounds,'white_complete_ink'))
   except ValueError:pass
  # Try a verified closed interior before the general text-area reconstruction.
  # This fallback is generated lazily only when ordinary white layout failed.
  errors=[];success=False
  for attempt in range(8):
   try:
    cleanup_attempt=attempt%4
    if cleanup_attempt==0:
     if paper is None:paper=PaperRecovery(image,segments,words)
     extra=mask if mismatch else None
     erase,replacement,safe,bounds,info=paper.prepare(segment,additional_mask=extra);method=info['method']
    elif cleanup_attempt==1:
     if not attempts:continue
     erase,replacement,safe,bounds,method=attempts[0]
    elif cleanup_attempt==2:
     if recovery is None:recovery=BalloonRecovery(image,segments,words)
     erase,replacement,safe,bounds,info=recovery.prepare(segment);method=info['method']
     if letters(group['text'])!=letters(rec['effective_source']):erase|=mask
    else:
     erase,replacement,safe,bounds=fallback_inpaint(image,segment,selected,segments,mask,expand_mask=letters(group['text'])!=letters(rec['effective_source']));method='bounded_telea_fallback'
    a,b,c,d=bounds;safe=safe.copy()&~ndi.binary_dilation(glyph_union[b:d,a:c],iterations=3)
    keep_punctuation=None;source=rec['effective_source'];variants=[target]
    if entry.get('short_text') and entry['short_text']!=target:variants.append(entry['short_text'])
    engine.FONT=APP/'font'/('DejaVuSans.ttf' if method in ('sampled_gray_texture','bounded_telea_fallback') else 'DejaVuSans-Bold.ttf')
    candidates=[(variant,{},True) for variant in variants] if attempt<4 else []
    if attempt>=4:
     for scale in (.78,.74):
      for uppercase in (True,False):
       candidates.extend((variant,{'width_scale':scale,'tight':True,'font_path':APP/'font'/'DejaVuSans.ttf'},uppercase) for variant in variants)
    for variant,layout_options,uppercase in candidates:
     layout_text=variant
     # Ornaments that are absent from OCR polygons stay in the original image.
     # Remove the corresponding translated tail instead of drawing it twice.
     preserved_tail=''
     if verified_box is None and ('♡' in source or '♥' in source):
      if not ('♡' in group['text'] or '♥' in group['text']):
       match=re.search(r'\s*([.…\s]*[♡♥])\s*$',layout_text)
       if match:preserved_tail=match.group(1).strip();layout_text=layout_text[:match.start()].strip()
     if verified_box is None and not preserved_tail and re.search(r'(…|\.\.\.)\s*$',layout_text) and not re.search(r'…|\.\.\.',group['text']):
      dots=retained_ellipsis(image,safe,bounds,erase,segment)
      if dots:
       keep_punctuation=dots;layout_text=re.sub(r'\s*(…|\.\.\.)\s*$','',layout_text);x,y,z,v=dots
       safe[max(0,y-b-4):min(d-b,v-b+4),max(0,x-a-4):min(c-a,z-a+4)]=False;preserved_tail='…'
     if not layout_text:continue
     try:layer,stats=engine.layout(layout_text.upper() if uppercase else layout_text,safe,bounds,segment,selected,**layout_options)
     except ValueError:continue
     full=Image.new('L',image.size);full.paste(layer,(a,b));alpha=np.asarray(full)
     outline=ndi.maximum_filter(alpha,size=3) if method in ('sampled_gray_texture','bounded_telea_fallback') else np.zeros_like(alpha)
     glyph=(alpha>0)|(outline>0)
     if (glyph&glyph_union).any():continue
     # An additional neighbour check covers the one-pixel white outline.
     foreign=np.zeros((H,W),bool)
     for other in segments:
      if other['id']==sid:continue
      x,y,z,v=map(int,other['word_box']);foreign[max(0,y-2):min(H,v+2),max(0,x-2):min(W,z+2)]=True
     if (glyph&foreign).any():continue
     norm=lambda text:re.sub(r'[\s-]','',text.upper())
     assert norm(''.join(x['text'] for x in stats['lines']))==norm(layout_text)
     glyph_union|=glyph;successful.append((erase,replacement,full,outline));success=True
     rec.update(status='rendered',method=method,font_size=stats['font_size'],lines=stats['lines'],
       used_compact_translation=variant!=target,retained_original_tail=preserved_tail,
       layout_fallback=bool(layout_options),kept_translation_case=not uppercase,width_scale=stats['width_scale'],font_file=stats['font_file'],tight_spacing=stats['tight_spacing'],
       reconstruction_requires_visual_quality_evaluation=method=='bounded_telea_fallback')
     break
    if success:break
    errors.append('Kein kollisionsfreier Satz ab 12px.')
   except ValueError as err:errors.append(str(err))
  if not success:rec['reason']='; '.join(errors[-2:])
 cleaned=original.copy();erased=np.zeros((H,W),bool)
 for mask,replacement,full,outline in successful:
  cleaned[mask]=255 if replacement is None else replacement[mask];erased|=mask
 final=Image.fromarray(cleaned)
 for mask,replacement,full,outline in successful:
  if outline.any():final.paste((255,255,255),(0,0),Image.fromarray(outline))
  final.paste((0,0,0),(0,0),full)
 result=np.asarray(final);assert np.array_equal(result[~(erased|glyph_union)],original[~(erased|glyph_union)])
 if np.array_equal(result[:,:,0],result[:,:,1]) and np.array_equal(result[:,:,0],result[:,:,2]):final=final.convert('L')
 engine.save_png(final,Path(dest))
 with Image.open(dest) as saved:assert np.array_equal(np.asarray(saved.convert('RGB')),result)
 return {'sequence':page['sequence'],'source_name':page['source_name'],'size':page['size'],'source_sha256':page['sha256'],
  'output_sha256':__import__('hashlib').sha256(Path(dest).read_bytes()).hexdigest(),'pixels_changed_outside_calculated_masks':0,
  'rendered':sum(r['status']=='rendered' for r in records),
  'unresolved_dialogue':sum(r['status']=='retained_source' for r in records),
  'records':records,'output_file':Path(dest).name}
