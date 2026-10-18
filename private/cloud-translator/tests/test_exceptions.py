from pathlib import Path
from copy import deepcopy
import argparse,io,json,shutil,sys,tempfile,unittest,zipfile
from unittest.mock import Mock
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'app'))
from bubble_exceptions import plan_cases,validate_reply,apply_units,repair_after_render,EXCEPTION_VERSION
from repair_saved import run
from services import JobError,save,filehash,Services
from render import render_page
import test_groups as fixtures
import test_pipeline as pipeline_fixtures
import pipeline
from test_groups import group,ocr_word


def unit(ids,source='HELLO WORLD',text='Hallo Welt',category='dialogue',**extra):
 result={'word_ids':ids,'category':category,'source_text':source,'reading':'complete','certainty':'clear','needs_more_context':False,
  'reason':'Simulierte Testantwort','text':text,'short_text':None,'source_box':None}
 result.update(extra);return result


class ExceptionTests(unittest.TestCase):
 def fixture(self,root):
  path=root/'source.png';image=Image.new('RGB',(500,600),'white');ImageDraw.Draw(image).rectangle((100,70,310,230),outline='black',width=3);image.save(path)
  gs=[group('a',[145,100,235,118],'HELLO',1),group('b',[145,135,235,153],'WORLD',2)]
  page={'path':str(path),'sha256':filehash(path),'size':[500,600],'sequence':1,'source_name':path.name}
  words={f'w{i:04d}':ocr_word(g) for i,g in enumerate(gs,1)}
  records=[{'id':'a','status':'rendered'},{'id':'b','status':'retained_source'}]
  return [(page,gs,words)],[{'sequence':1,'records':records}]

 def test_plan_captures_whole_utterance_and_never_artwork(self):
  with tempfile.TemporaryDirectory() as t:
   prepared,pages=self.fixture(Path(t));prepared[0][1].append(group('art',[150,160,220,175],'eye',3,disposition='preserved_artwork'))
   cases,plan=plan_cases(prepared,pages)
   self.assertEqual(len(cases),1);self.assertEqual(set(cases[0]['group_ids']),{'a','b'});self.assertEqual(set(cases[0]['word_ids']),{'w0001','w0002'})
   self.assertEqual(plan['planned_openai_batches'],1)

 def test_plan_cap_and_duplicate_source_pages_have_unique_cases(self):
  with tempfile.TemporaryDirectory() as t:
   prepared,pages=self.fixture(Path(t));many=[];records=[]
   for n in range(1,14):
    p,gs,ws=deepcopy(prepared[0]);p['sequence']=n;many.append((p,gs,ws));records.append({'sequence':n,'records':deepcopy(pages[0]['records'])})
   cases,plan=plan_cases(many,records)
   self.assertEqual(len(cases),12);self.assertEqual(len({c['id'] for c in cases}),12);self.assertEqual(plan['deferred_cases'],1)

 def test_partition_rejects_missing_duplicate_and_foreign_word_ids(self):
  case={'id':'case','word_ids':['a','b'],'crop_box':[0,0,100,100]}
  for ids in [['a'],['a','a','b'],['a','b','foreign']]:
   with self.subTest(ids=ids),self.assertRaises(JobError):validate_reply({'cases':[{'id':'case','units':[unit(ids)]}]},[case])
  self.assertIn('case',validate_reply({'cases':[{'id':'case','units':[unit(['a','b'])]}]},[case]))

 def test_uncertain_or_non_dialogue_cannot_carry_translation(self):
  case={'id':'case','word_ids':['a'],'crop_box':[0,0,100,100]}
  for row in [unit(['a'],reading='partial'),unit(['a'],category='background_text'),unit(['a'],text=None,short_text='Hallo')]:
   with self.assertRaises(JobError):validate_reply({'cases':[{'id':'case','units':[row]}]},[case])

 def test_untranslated_complete_unit_replaces_all_previous_fragments(self):
  with tempfile.TemporaryDirectory() as t:
   prepared,pages=self.fixture(Path(t));cases,_=plan_cases(prepared,pages);case=cases[0];p,gs,ws=prepared[0]
   reply=validate_reply({'cases':[{'id':case['id'],'units':[unit(case['word_ids'],text=None)]}]},cases)
   ng,nt=apply_units(p,gs,cases,reply,{'a':{'text':'Hallo'},'b':{'text':None}})
   self.assertEqual(len(ng),1);self.assertEqual(len(ng[0]['words']),2);self.assertIsNone(nt[ng[0]['id']]['text']);self.assertNotIn('a',nt)
   record=render_page(p,ng,ws,nt,str(Path(t)/'out.png'))
   self.assertEqual(record['records'][0]['status'],'retained_source')
   self.assertEqual(Image.open(p['path']).tobytes(),Image.open(Path(t)/'out.png').convert('RGB').tobytes())
   self.assertEqual(plan_cases([(p,ng,ws)],[record])[0],[])

 def test_unsafe_predicted_extent_withholds_whole_unit(self):
  with tempfile.TemporaryDirectory() as t:
   prepared,pages=self.fixture(Path(t));cases,_=plan_cases(prepared,pages);case=cases[0];p,gs,ws=prepared[0]
   row=unit(case['word_ids'],source_box=[0,0,1,1])
   ng,nt=apply_units(p,gs,cases,{case['id']:[row]},{});self.assertEqual(ng[0]['disposition'],'retained_unresolved');self.assertNotIn(ng[0]['id'],nt)

 def make_completed_source(self,root):
  fixtures.GroupingTests().make_job(root)
  # This runner consumes finished jobs, so supply complete real page records.
  pages=[];targets={}
  for n in [1,2]:
   stored=json.loads((root/'prepared'/f'{n:04d}.json').read_text());p=stored['page'];p['path']=str(root/'originale'/f'{n:04d}.png')
   gs=stored['groups'];ws={f'w{i:04d}':ocr_word(g) for i,g in enumerate(gs,1)}
   ts={g['id']:{'text':None if n==1 else 'Hallo','short_text':None} for g in gs};targets.update(ts)
   (root/'seiten').mkdir(exist_ok=True);record=render_page(p,gs,ws,ts,str(root/'seiten'/f'{n:04d}.png'));pages.append(record)
  save(root/'uebersetzung.json',{'translations':targets});save(root/'ergebnisse.json',{'summary':{'input_pages':2},'pages':pages})
  return pages

 def test_completed_job_preserves_source_and_unaffected_page_resumes_without_api(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';job=Path(t)/'job';self.make_completed_source(source)
   before={str(f.relative_to(source)):f.read_bytes() for f in source.rglob('*') if f.is_file()};calls=[]
   def transport(service,payload):
    calls.append((service,payload));self.assertEqual(service,'openai')
    contents=payload['input'][0]['content'];context=json.loads(contents[0]['text']);self.assertEqual(len(context['chapter']),3)
    case=json.loads(contents[1]['text']);ids=[w['id'] for w in case['eligible_words']]
    return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'cases':[{'id':case['case_id'],'units':[unit(ids)]}]})}]}]}
   state=run(source,job,transport=transport);self.assertIn(state['status'],('completed','completed_with_retained_regions'));self.assertEqual(len(calls),1)
   self.assertEqual(state['new_api_calls'],{'openai':1,'google':0})
   self.assertEqual((job/'seiten/0002.png').read_bytes(),before['seiten/0002.png'])
   for rel,content in before.items():self.assertEqual((source/rel).read_bytes(),content)
   with zipfile.ZipFile(job/'kapitel-de.cbz') as z:self.assertEqual(z.namelist(),['0001.png','0002.png']);self.assertEqual(z.read('0001.png'),(job/'seiten/0001.png').read_bytes())
   again=run(source,job,transport=Mock(side_effect=AssertionError('Unexpected paid request')));self.assertEqual(again['status'],'already_completed')

 def test_refusal_is_not_retried_and_failed_source_is_not_submitted(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';job=Path(t)/'job';self.make_completed_source(source)
   transport=Mock(return_value={'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':'Declined'}]}]})
   state=run(source,job,transport=transport);self.assertEqual(state['status'],'failed');self.assertEqual(transport.call_count,1)
   with self.assertRaises(JobError):run(job,Path(t)/'another',transport=transport)
   self.assertEqual(transport.call_count,1)

 def test_image_answer_cache_reused_after_failed_validation_without_http_retry(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';job=Path(t)/'job';self.make_completed_source(source)
   transport=Mock(return_value={'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':'{"cases":[]}'}]}]})
   self.assertEqual(run(source,job,transport=transport)['status'],'failed')
   self.assertEqual(run(source,job,transport=transport)['status'],'failed');self.assertEqual(transport.call_count,1)

 def test_new_chapter_runs_exception_pass_automatically_and_reuses_paid_answers(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);src=root/'src';src.mkdir();Image.new('RGB',(120,100),'white').save(src/'0001.png');calls=[]
   def transport(service,payload):
    calls.append(service)
    if service=='google':return pipeline_fixtures.raw_ocr()
    if payload['text']['format']['name']=='comic_complete_unit_repair':
     case=json.loads(payload['input'][0]['content'][1]['text']);ids=[w['id'] for w in case['eligible_words']]
     return pipeline_fixtures.make_response({'cases':[{'id':case['case_id'],'units':[unit(ids,source='HELLO',text='Hallo')]}]})
    ids=payload['text']['format']['schema']['properties']['translations']['items']['properties']['id']['enum']
    return pipeline_fixtures.make_response({'translations':[{'id':sid,'text':None,'short_text':None} for sid in ids]})
   args=argparse.Namespace(input=src,output=root/'out',seed=root/'seed',live=True,model='model',max_openai=10,max_google=10,plan=False,workers=1,batch_size=60)
   first=pipeline.run(args,transport=transport);self.assertEqual(first['status'],'completed');self.assertEqual(calls,['google','openai','openai'])
   self.assertEqual(first['exception_review']['reviewed_cases'],1);before=(root/'out/seiten/0001.png').read_bytes()
   again=pipeline.run(args,transport=Mock(side_effect=AssertionError('Duplicate paid request')))
   self.assertEqual(again['status'],'completed');self.assertEqual(again['new_api_calls'],{'openai':0,'google':0});self.assertEqual(before,(root/'out/seiten/0001.png').read_bytes())

if __name__=='__main__':unittest.main()
