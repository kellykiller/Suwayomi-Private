from pathlib import Path
import sys,tempfile,json,copy,argparse,zipfile
import unittest
from unittest.mock import Mock,patch
import numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'app'))
from services import Services,JobError,AmbiguousRequest,save,digest
from prepare import collect,groups_for
from language import translate,prepare_reviews,review,check_review,suspicious
from pipeline import run,disposition
from render import render_page

def make_response(text):return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(text)}]}]}
def raw_word(text,a=30,b=30,c=80,d=50):
 return {'boundingBox':{'vertices':[{'x':a,'y':b},{'x':c,'y':b},{'x':c,'y':d},{'x':a,'y':d}]},'confidence':.99,'symbols':[{'text':letter} for letter in text]}
def raw_ocr():return {'responses':[{'fullTextAnnotation':{'pages':[{'width':120,'height':100,'blocks':[{'paragraphs':[{'words':[raw_word('Hello')]}]}]}]}}]}

class JobTests(unittest.TestCase):
 def test_successful_api_response_is_reused_without_another_network_request(self):
  transport=Mock(return_value={'status':'completed'})
  with tempfile.TemporaryDirectory() as p:
   service=Services(p,live=True,transport=transport)
   first=service.call('openai',{'model':'test'});second=service.call('openai',{'model':'test'})
   self.assertEqual(first,second);self.assertEqual(service.new['openai'],1);self.assertEqual(service.hits,1)
  self.assertEqual(transport.call_count,1)
 def test_timeout_marker_prevents_automatic_duplicate_billing(self):
  with tempfile.TemporaryDirectory() as p:
   service=Services(p,live=True,transport=Mock(side_effect=AmbiguousRequest('timeout')))
   with self.assertRaises(AmbiguousRequest):service.call('openai',{'a':1})
   again=Services(p,live=True,transport=Mock())
   with self.assertRaises(AmbiguousRequest):again.call('openai',{'a':1})
   again.transport.assert_not_called()
 def test_request_limit_stops_before_another_network_call(self):
  with tempfile.TemporaryDirectory() as p:
   service=Services(p,live=True,max_openai=1,transport=Mock(return_value={}))
   service.call('openai',{'a':1})
   with self.assertRaises(JobError):service.call('openai',{'a':2})
   self.assertEqual(service.transport.call_count,1)
 def test_cache_identity_depends_on_source_and_model(self):
  self.assertNotEqual(digest({'model':'a','source':'x'}),digest({'model':'b','source':'x'}))
  self.assertNotEqual(digest({'model':'a','source':'x'}),digest({'model':'a','source':'y'}))
 def test_new_input_uses_every_google_word_once(self):
  page={'size':[120,100],'sha256':'not_seeded','sequence':1}
  groups,words,origin=groups_for(page,raw_ocr(),ROOT/'seed')
  self.assertEqual(origin,'geometric_paragraph_fallback')
  self.assertEqual([w['id'] for g in groups for w in g['words']],list(words))
 def test_image_order_is_natural_and_source_is_not_modified(self):
  with tempfile.TemporaryDirectory() as p:
   p=Path(p);src=p/'src';src.mkdir()
   for name in ['10.png','2.png','cover.png']:Image.new('RGB',(40,50),'white').save(src/name)
   before={f.name:f.read_bytes() for f in src.iterdir()}
   pages=collect(src,p/'job');self.assertEqual([x['source_name'] for x in pages],['2.png','10.png','cover.png'])
   self.assertEqual(before,{f.name:f.read_bytes() for f in src.iterdir()})
 def test_cbz_member_paths_cannot_escape_the_job(self):
  with tempfile.TemporaryDirectory() as p:
   p=Path(p);Image.new('RGB',(40,50),'white').save(p/'page.png')
   with zipfile.ZipFile(p/'input.cbz','w') as z:z.write(p/'page.png','../../outside.png')
   with self.assertRaises(JobError):collect(p/'input.cbz',p/'job')
   self.assertFalse((p/'outside.png').exists())
 def test_partial_or_ambiguous_review_is_not_translated(self):
  self.assertEqual(disposition({'certainty':'ambiguous','needs_more_context':False,'reading':'complete','category':'dialogue'}),'retained_unresolved')
  self.assertEqual(disposition({'certainty':'clear','needs_more_context':False,'reading':'partial','category':'dialogue'}),'retained_unresolved')
 def test_punctuation_and_artwork_are_preserved_without_drawing_model_dots(self):
  self.assertEqual(disposition({'certainty':'clear','needs_more_context':False,'reading':'complete','category':'punctuation'}),'preserved_punctuation')
  self.assertEqual(disposition({'certainty':'clear','needs_more_context':False,'reading':'not_text','category':'artwork'}),'preserved_artwork')
 def test_translation_batches_all_receive_whole_chapter_context(self):
  groups=[{'id':f'id{i}','page_sequence':i+1,'effective_source':'Hello','text_box':[0,0,1,1]} for i in range(3)]
  payloads=[]
  class Fake:
   def call(self,service,payload):
    payloads.append(payload);ids=payload['text']['format']['schema']['properties']['translations']['items']['properties']['id']['enum']
    return make_response({'translations':[{'id':sid,'text':'Hallo','short_text':'Hallo'} for sid in ids]})
  with tempfile.TemporaryDirectory() as p:result=translate(groups,ROOT/'seed',Path(p),Fake(),'model',batch_size=2)
  self.assertEqual(len(result),3);self.assertEqual(len(payloads),2)
  for payload in payloads:self.assertEqual(len(json.loads(payload['input'][0]['content'][0]['text'])['chapter']),3)
 def test_missing_or_duplicate_translation_ids_are_rejected(self):
  service=Mock();service.call.return_value=make_response({'translations':[]})
  with tempfile.TemporaryDirectory() as p:
   with self.assertRaises(JobError):translate([{'id':'x','page_sequence':1,'effective_source':'Hi','text_box':[0,0,1,1]}],ROOT/'seed',Path(p),service,'model')
 def test_tiny_offline_job_produces_a_readable_png_cbz_and_report(self):
  with tempfile.TemporaryDirectory() as p:
   p=Path(p);src=p/'src';src.mkdir();Image.new('RGB',(120,100),'white').save(src/'0001.png')
   from services import filehash
   sha=filehash(src/'0001.png');seed=p/'seed';save(seed/'ocr'/f'{sha}.json',{'responses':[{}]});save(seed/'offline-drafts.json',{'translations':{}})
   args=argparse.Namespace(input=src,output=p/'out',seed=seed,live=False,model='model',max_openai=1,max_google=1,plan=False,workers=1,batch_size=60)
   result=run(args);self.assertEqual(result['status'],'completed')
   self.assertEqual(json.loads((p/'out/lauf.json').read_text())['new_api_calls'],{'openai':0,'google':0})
   self.assertTrue((p/'out/bericht.html').is_file())
   with zipfile.ZipFile(p/'out/kapitel-de.cbz') as z:self.assertEqual(z.namelist(),['0001.png'])
 def test_batch_review_retries_only_unclear_crop_once_and_reuses_answers(self):
  with tempfile.TemporaryDirectory() as directory:
   p=Path(directory);Image.new('RGB',(240,200),'white').save(p/'source.png')
   page={'sha256':'sha','path':str(p/'source.png')}
   groups=[{'id':f'g{i}','text':'X','kind':'unassigned','words':[], 'box':[20+i*40,30,50+i*40,60],'text_box':[25+i*40,35,45+i*40,55]} for i in range(2)]
   clear={'category':'dialogue','transcription':'Yes','reading':'complete','certainty':'clear','needs_more_context':False,'reason':'Lesbar.'}
   unclear={**clear,'certainty':'ambiguous','needs_more_context':True}
   transport=Mock(side_effect=[make_response({'reviews':[{'id':'g0','answer':clear},{'id':'g1','answer':unclear}]}),make_response(unclear)])
   service=Services(p/'api',live=True,transport=transport)
   prepare_reviews(groups,page,p/'seed',p/'job',service,'model')
   results=[review(g,page,groups,p/'seed',p/'job',service,'model') for g in groups]
   self.assertEqual(len(transport.call_args_list),2)
   self.assertEqual(results[0][0]['certainty'],'clear');self.assertEqual(results[1][0]['certainty'],'ambiguous')
   prepare_reviews(groups,page,p/'seed',p/'job',service,'model')
   for g in groups:review(g,page,groups,p/'seed',p/'job',service,'model')
   self.assertEqual(transport.call_count,2)
 def test_live_pipeline_with_simulated_google_and_openai_then_cached_restart(self):
  with tempfile.TemporaryDirectory() as directory:
   p=Path(directory);src=p/'src';src.mkdir();Image.new('RGB',(120,100),'white').save(src/'0001.png')
   calls=[]
   def transport(service,payload):
    calls.append(service)
    if service=='google':return raw_ocr()
    ids=payload['text']['format']['schema']['properties']['translations']['items']['properties']['id']['enum']
    return make_response({'translations':[{'id':sid,'text':'Hallo','short_text':'Hallo'} for sid in ids]})
   args=argparse.Namespace(input=src,output=p/'out',seed=p/'seed',live=True,model='model',max_openai=10,max_google=10,plan=False,workers=1,batch_size=60)
   first=run(args,transport=transport)
   self.assertEqual(first['status'],'completed');self.assertEqual(calls,['google','openai'])
   png=(p/'out/seiten/0001.png').read_bytes()
   again=run(args,transport=Mock(side_effect=AssertionError('Unexpected network call')))
   self.assertEqual(again['new_api_calls'],{'openai':0,'google':0})
   self.assertEqual((p/'out/seiten/0001.png').read_bytes(),png)
   self.assertEqual(json.loads((p/'out/ergebnisse.json').read_text())['summary']['output_pages'],1)
 def test_isolated_punctuation_does_not_spend_an_ocr_review_request(self):
  self.assertFalse(suspicious({'text':'...?!','kind':'unassigned','words':[{'confidence':0.1}]}))
 def test_review_rejects_wrong_transcription_type(self):
  with self.assertRaises(JobError):check_review({'category':'dialogue','transcription':17,'reading':'complete','certainty':'clear','needs_more_context':False,'reason':'x'})
 def test_punctuation_is_kept_pixel_for_pixel_even_if_model_miscounts_dots(self):
  # The model returned four dots; preservation must keep the three original dots.
  # Exercise the pixel-identity path independently using a synthetic punctuation page.
  with tempfile.TemporaryDirectory() as p:
   p=Path(p);im=Image.new('RGB',(100,120),'white');draw=ImageDraw.Draw(im)
   for y in [35,55,75]:draw.ellipse((46,y,52,y+6),fill='black')
   im.save(p/'src.png');word=raw_word('Q',40,30,60,90)
   g={'id':'g','kind':'bubble','box':[20,10,80,110],'text_box':[40,30,60,90],'words':[{'id':'w0001'}],'text':'Q','disposition':'preserved_punctuation','review':{'transcription':'....'}}
   page={'path':str(p/'src.png'),'sequence':1,'source_name':'src.png','size':[100,120],'sha256':'sha'}
   rec=render_page(page,[g],{'w0001':word},{},p/'out.png')
   self.assertTrue(np.array_equal(np.array(im),np.array(Image.open(p/'out.png').convert('RGB'))))
   self.assertEqual(rec['records'][0]['status'],'preserved_punctuation')

if __name__=='__main__':unittest.main()
