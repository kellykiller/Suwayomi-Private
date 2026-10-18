from pathlib import Path
import re,json,zipfile,base64,copy,io
import numpy as np,cv2
from PIL import Image
import assign_core as assign
from services import save,filehash,JobError

from image_input import EXTENSIONS, InputError, pages as input_pages, png_bytes, natural

def collect(source,job):
 dest=Path(job)/'originale';dest.mkdir(parents=True,exist_ok=True)
 result=[];working_bytes=0
 try:
  for sequence,page in enumerate(input_pages(source),1):
   data=page['original'] if page['original'] is not None else png_bytes(page['image'])
   working_bytes+=len(data)
   if working_bytes>2*1024**3:raise JobError('PNG-Arbeitskopien groesser als 2 GiB.')
   import hashlib
   sha=hashlib.sha256(data).hexdigest();path=dest/f"{sequence:04d}{page['suffix']}"
   if not path.exists() or filehash(path)!=sha:path.write_bytes(data)
   result.append({'sequence':sequence,'source_name':page['name'],'path':str(path.resolve()),
                  'sha256':sha,'size':list(page['image'].size)})
 except InputError as error:
  raise JobError(str(error)) from None
 return result

def read_ocr(page,seed,services,job):
 sha=page['sha256'];cached=Path(seed)/'ocr'/f'{sha}.json';local=Path(job)/'ocr'/f'{sha}.json'
 if local.exists():raw=json.loads(local.read_text())
 elif cached.exists():raw=json.loads(cached.read_text())
 else:
  data=base64.b64encode(Path(page['path']).read_bytes()).decode()
  raw=services.call('google',{'requests':[{'image':{'content':data},'features':[{'type':'DOCUMENT_TEXT_DETECTION'}]}]})
 response=raw.get('responses',[{}])[0]
 if 'error' in response:raise JobError('Google OCR hat einen Fehler geliefert; Original bleibt erhalten.')
 save(local,raw);return raw

def raw_words(raw,size):
 response=raw.get('responses',[{}])[0];words=assign.ocr_words(response,size);objects={};index=0
 for pg in response.get('fullTextAnnotation',{}).get('pages',[]):
  sx,sy=size[0]/pg['width'],size[1]/pg['height']
  for block in pg.get('blocks',[]):
   for para in block.get('paragraphs',[]):
    for w in para.get('words',[]):
     obj=copy.deepcopy(w)
     for v in obj['boundingBox']['vertices']:v['x']=round(v.get('x',0)*sx);v['y']=round(v.get('y',0)*sy)
     index+=1;objects[f'w{index:04d}']=obj
 return words,objects

def generic_regions(words,size):
 # Deterministic geometric fallback for new chapters. The example uses cached
 # detector assignments. This fallback is not a learned balloon/panel detector.
 buckets={}
 for w in words:
  w['assignment_ambiguous']=False;w['assignment_method']='paragraph_fallback'
  buckets.setdefault(tuple(w['paragraph']),[]).append(w)
 groups=[];W,H=size
 for ws in buckets.values():
  box=assign.union([w['box'] for w in ws]);h=float(np.median([w['box'][3]-w['box'][1] for w in ws]));pad=max(12,min(60,h*1.7))
  placement=[max(0,int(box[0]-pad)),max(0,int(box[1]-pad)),min(W,int(box[2]+pad)),min(H,int(box[3]+pad))]
  groups.append({'source_id':None,'box':placement,'text_box':box,'score':None,'kind':'bubble','words':ws})
 return groups

def groups_for(page,raw,seed):
 words,objects=raw_words(raw,page['size']);p=Path(seed)/'regions'/f"{page['sha256']}.json"
 if p.exists():
  entry=json.loads(p.read_text());groups=entry['groups'];origin='cached_detector_assignment'
  expected={w['id'] for g in groups for w in g['words']}
  if expected!=set(objects):raise JobError('Gespeicherte Zuordnung passt nicht zu OCR.')
 else:
  groups=assign.finalize(generic_regions(words,page['size']),page['sequence'],'rtl',page['size']);origin='geometric_paragraph_fallback'
 ids=[w['id'] for g in groups for w in g['words']]
 if len(ids)!=len(set(ids)) or set(ids)!=set(objects):raise JobError('OCR-Woerter nicht genau einmal zugeordnet.')
 for index,g in enumerate(groups,1):
  g['seed_id']=g['id'];g['id']=f"p{page['sequence']:04d}-r{index:03d}"
  g['page_sha256']=page['sha256'];g['page_sequence']=page['sequence']
 return groups,objects,origin
