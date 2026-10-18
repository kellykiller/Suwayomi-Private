from pathlib import Path
import argparse,hashlib,io,json,sys,tempfile,unittest
from unittest.mock import Mock
import numpy as np
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'app'))
from text_groups import merge_dialogue_groups
from services import save,filehash,JobError
from regroup_saved import run


def group(sid,box,text='HELLO',index=1,disposition='translate',source_id=None):
 word={'id':f'w{index:04d}','text':text,'box':list(box),'paragraph':[0,index,0],'paragraph_position':0,'confidence':.99,'break':'LINE_BREAK','assignment_ambiguous':False}
 return {'id':sid,'kind':'bubble','box':[box[0]-15,box[1]-15,box[2]+15,box[3]+15],'text_box':list(box),'text':text,'source_lines':text,'words':[word],
  'disposition':disposition,'effective_source':text,'review_origin':'ocr_heuristic','review':{'category':'dialogue','transcription':text,'reading':'complete','certainty':'clear','needs_more_context':False,'reason':'fixture'},'page_sequence':1,'source_id':source_id}


def ocr_word(g):
 a,b,c,d=g['text_box'];return {'confidence':.99,'boundingBox':{'vertices':[{'x':a,'y':b},{'x':c,'y':b},{'x':c,'y':d},{'x':a,'y':d}]},'symbols':[{'text':c} for c in g['text']]}

class GroupingTests(unittest.TestCase):
 def image(self,path,rectangles):
  im=Image.new('RGB',(500,600),'white');d=ImageDraw.Draw(im)
  for box in rectangles:d.rectangle(box,outline='black',width=3)
  im.save(path);return {'path':str(path),'sequence':1}
 def test_same_closed_bubble_merges_in_visual_order_without_losing_words(self):
  with tempfile.TemporaryDirectory() as t:
   page=self.image(Path(t)/'p.png',[(100,70,310,230)]);gs=[group('bottom',[145,160,235,178],'WORLD',1),group('top',[145,100,235,118],'HELLO',2)]
   before=filehash(page['path']);out,summary=merge_dialogue_groups(page,gs)
   self.assertEqual(len(out),1);self.assertEqual(out[0]['effective_source'],'HELLO WORLD');self.assertEqual(out[0]['member_ids'],['top','bottom']);self.assertEqual(filehash(page['path']),before)
   self.assertEqual({w['id'] for w in out[0]['words']},{'w0001','w0002'})
 def test_adjacent_bubbles_do_not_merge(self):
  with tempfile.TemporaryDirectory() as t:
   page=self.image(Path(t)/'p.png',[(40,50,200,220),(204,50,365,220)]);gs=[group('a',[70,100,170,118],index=1),group('b',[230,120,330,138],index=2)]
   out,s=merge_dialogue_groups(page,gs);self.assertEqual(len(out),2);self.assertEqual(s['merged_blocks'],0)
 def test_thin_neck_between_bubbles_does_not_merge_separate_dialogues(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'p.png';im=Image.new('RGB',(500,600),'#808080');d=ImageDraw.Draw(im)
   d.rectangle((100,40,250,120),fill='white',outline='black',width=3);d.rectangle((100,124,250,205),fill='white',outline='black',width=3);d.rectangle((170,116,177,130),fill='white');im.save(p)
   gs=[group('a',[135,83,220,97],index=1),group('b',[135,134,220,148],index=2)]
   out,s=merge_dialogue_groups({'path':str(p)},gs);self.assertEqual(len(out),2)
 def test_artwork_and_uncertain_classification_stays_separate(self):
  with tempfile.TemporaryDirectory() as t:
   page=self.image(Path(t)/'p.png',[(100,70,310,230)]);gs=[group('a',[145,100,235,118],index=1),group('b',[145,135,235,153],index=2,disposition='preserved_artwork')]
   out,s=merge_dialogue_groups(page,gs);self.assertEqual(len(out),2);self.assertEqual(out[1]['disposition'],'preserved_artwork')
 def test_separate_detector_ids_are_respected(self):
  with tempfile.TemporaryDirectory() as t:
   page=self.image(Path(t)/'p.png',[(100,70,310,230)]);gs=[group('a',[145,100,235,118],index=1,source_id=1),group('b',[145,135,235,153],index=2,source_id=2)]
   self.assertEqual(len(merge_dialogue_groups(page,gs)[0]),2)
 def test_open_page_background_is_not_a_bubble(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'p.png';Image.new('RGB',(500,600),'white').save(p);gs=[group('a',[145,100,235,118],index=1),group('b',[145,135,235,153],index=2)]
   self.assertEqual(len(merge_dialogue_groups({'path':str(p)},gs)[0]),2)
 def make_job(self,root):
  (root/'originale').mkdir(parents=True);pages=[];targets={}
  for n in [1,2]:
   path=root/'originale'/f'{n:04d}.png';im=Image.new('RGB',(500,600),'white');draw=ImageDraw.Draw(im);draw.rectangle((100,70,310,210),outline='black',width=3)
   gs=[group(f'p{n}-a',[145,100,235,118],'HELLO',1)]
   if n==1:gs.append(group(f'p{n}-b',[145,135,235,153],'WORLD',2))
   for g in gs:
    g['page_sequence']=n;draw.text((g['text_box'][0],g['text_box'][1]),g['text'],font=ImageFont.truetype(str(ROOT/'app/font/DejaVuSans-Bold.ttf'),16),fill='black');targets[g['id']]={'text':'Hallo' if g['text']=='HELLO' else 'Welt','short_text':None,'origin':'saved_fixture'}
   im.save(path);sha=filehash(path);page={'sequence':n,'path':'/output/originale/'+path.name,'sha256':sha,'size':[500,600],'source_name':path.name}
   save(root/'prepared'/f'{n:04d}.json',{'page':page,'groups':gs});save(root/'ocr'/f'{sha}.json',{'responses':[{'fullTextAnnotation':{'pages':[{'width':500,'height':600,'blocks':[{'paragraphs':[{'words':[ocr_word(g)]} for g in gs]}]}]}}]});pages.append({'sequence':n})
  save(root/'ergebnisse.json',{'summary':{'input_pages':2},'pages':pages});save(root/'uebersetzung.json',{'translations':targets});save(root/'manifest.json',{'model':'test-model','signature':'original'})
  save(root/'lauf.json',{'version':'0.2.0','status':'completed_with_retained_regions','mode':'live'})
 def test_saved_job_translates_only_joined_block_with_whole_chapter_context(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';out=Path(t)/'out';self.make_job(source);before={str(f.relative_to(source)):f.read_bytes() for f in source.rglob('*') if f.is_file()};calls=[]
   def transport(service,payload):
    calls.append((service,payload));self.assertEqual(service,'openai');ids=payload['text']['format']['schema']['properties']['translations']['items']['properties']['id']['enum'];self.assertEqual(ids,['p1-a'])
    context=json.loads(payload['input'][0]['content'][0]['text'])['chapter'];self.assertEqual({g['id'] for g in context},{'p1-a','p2-a'})
    return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'translations':[{'id':i,'text':'Hallo Welt','short_text':'Hallo Welt'} for i in ids]})}]}]}
   result=run(source,out,workers=1,transport=transport);self.assertIn(result['status'],('completed','completed_with_retained_regions'));self.assertEqual(len(calls),1);self.assertEqual(result['new_api_calls']['google'],0)
   result_pages=json.loads((out/'ergebnisse.json').read_text())['pages'];self.assertEqual(len(result_pages[0]['records']),1);self.assertEqual(result_pages[0]['records'][0]['status'],'rendered')
   for rel,data in before.items():self.assertEqual((source/rel).read_bytes(),data)
   again=run(source,out,workers=1,transport=Mock(side_effect=AssertionError('Unexpected API retry')));self.assertEqual(again['status'],'already_completed')
 def test_failed_or_rejected_job_is_not_resubmitted(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';source.mkdir();save(source/'lauf.json',{'status':'failed','mode':'live'})
   service=Mock()
   with self.assertRaises(JobError):run(source,Path(t)/'out',transport=service)
   service.assert_not_called()

if __name__=='__main__':unittest.main()
