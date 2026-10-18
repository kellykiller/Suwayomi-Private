"""Conservative image-backed grouping of reviewed dialogue fragments.

No page numbers, words or chapter-specific exceptions. This is not a learned
balloon detector. Unclosed/ambiguous regions remain separate.
"""
from copy import deepcopy
from collections import defaultdict
import math
import cv2
import numpy as np
from PIL import Image
import assign_core as assign
from services import JobError
from paper_regions import closed_light_regions, container_for_boxes

GROUPING_VERSION='1.1.0'


def _near(a,b,labels=None,label=None):
 # Neighboring lines must align and be no more than a few glyph heights apart.
 x,y,z,v=a['text_box'];p,q,r,s=b['text_box']
 h=float(np.median([max(1,w['box'][3]-w['box'][1]) for g in (a,b) for w in g['words']]))
 overlap=max(0,min(z,r)-max(x,p));width=max(1,min(z-x,r-p))
 aligned=overlap/width>=.25 or abs((x+z-p-r)/2)<=max(z-x,r-p)*.35
 gap=max(0,y-s,q-v)
 if not aligned or gap>max(8,h*2.6):return False
 if labels is not None and gap>0:
  # A thin neck between two connected balloons is insufficient evidence for
  # one text block. Source glyph rows themselves are excluded from this test.
  top=int(min(v,s));bottom=int(max(y,q));a0=int(min(x,p));a1=int(max(z,r))
  corridor=(labels[top:bottom,max(0,a0-5):a1+5]==label).sum(axis=1)
  if len(corridor) and int(corridor.min())<max(8,h*.7):return False
 return True


def _regions(gray):
 return closed_light_regions(gray)


def _container(group,labels,candidates):
 return container_for_boxes([w['box'] for w in group['words']],labels,candidates)


def merge_dialogue_groups(page,groups):
 if not groups:return [],{'version':GROUPING_VERSION,'merged_blocks':0,'merged_members':0}
 original_ids=[w['id'] for g in groups for w in g['words']]
 if len(original_ids)!=len(set(original_ids)):raise JobError('OCR-Wort bereits vor Gruppierung mehrfach zugeordnet.')
 gray=np.asarray(Image.open(page['path']).convert('L'));labels,regions=_regions(gray)
 buckets=defaultdict(list)
 for g in groups:
  # The classifier's preserved artwork, punctuation, effects and uncertain
  # readings are not silently converted into dialogue by geometry.
  if g.get('disposition')!='translate' or not g.get('words'):continue
  lab=_container(g,labels,regions)
  if lab is not None:buckets[lab].append(g)
 merged_by_id={};removed=set();blocks=[]
 for lab,members in buckets.items():
  if len(members)<2:continue
  # Keep independently detected balloons distinct even if an image contour leaks.
  detector_ids={g.get('source_id') for g in members if g.get('source_id') is not None}
  if len(detector_ids)>1:continue
  pending=set(range(len(members)))
  while pending:
   first=min(pending);pending.remove(first);component=[first];stack=[first]
   while stack:
    current=stack.pop()
    for other in sorted(pending):
     if _near(members[current],members[other],labels,lab):pending.remove(other);component.append(other);stack.append(other)
   chunk=[members[i] for i in component]
   if len(chunk)<2:continue
   chunk.sort(key=lambda g:(g['text_box'][1],g['text_box'][0],g['id']))
   ids=[g['id'] for g in chunk];words=[deepcopy(w) for g in chunk for w in g['words']]
   result=deepcopy(chunk[0]);lines,ocr=assign.text_for(words)
   source=' '.join(g.get('effective_source',g['text']).strip() for g in chunk).strip()
   result.update(words=words,text_box=assign.union([g['text_box'] for g in chunk]),box=regions[lab],text=ocr,source_lines=lines,
    effective_source=source,member_ids=ids,member_groups=deepcopy(chunk),grouping_version=GROUPING_VERSION,grouping_method='shared_closed_light_interior',
    review_origin='grouped_reviews',review={'category':'dialogue','transcription':source,'reading':'complete','certainty':'clear','needs_more_context':False,'reason':'Lesbare Dialogteile in derselben geschlossenen hellen Bildflaeche zusammengefuehrt.'})
   merged_by_id[result['id']]=result;removed.update(ids);blocks.append({'id':result['id'],'member_ids':ids,'box':result['box']})
 output=[]
 for g in groups:
  if g['id'] in merged_by_id:output.append(merged_by_id[g['id']])
  elif g['id'] not in removed:output.append(deepcopy(g))
 # Reading order is recomputed after merging. In particular the first source
 # line cannot remain after its following four lines in a split caption.
 dialogue=assign.reading_order([g for g in output if g.get('disposition')=='translate'],'rtl',gray.shape[0]*.04)
 rest=[g for g in output if g.get('disposition')!='translate'];output=dialogue+rest
 after_ids=[w['id'] for g in output for w in g['words']]
 if len(after_ids)!=len(original_ids) or set(after_ids)!=set(original_ids):raise JobError('Gruppierung hat OCR-Woerter verloren oder mehrfach zugeordnet.')
 return output,{'version':GROUPING_VERSION,'merged_blocks':len(blocks),'merged_members':sum(len(b['member_ids']) for b in blocks),'blocks':blocks}
