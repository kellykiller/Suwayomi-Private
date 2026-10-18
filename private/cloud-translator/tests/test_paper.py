"""Regression coverage for tinted scans, protected artwork, and migration reuse."""
from pathlib import Path
import json,sys,tempfile,unittest
from unittest.mock import Mock
import numpy as np
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app'))
from paper_regions import PaperRecovery
from text_groups import merge_dialogue_groups
from render import render_page
from regroup_saved import run
from test_groups import group,ocr_word
import test_groups as grouping_fixtures


class PaperTests(unittest.TestCase):
 def fixture(self,folder,closed=True,line=False):
  # Nonstationary yellow paper with deterministic fine grain, not a flat fill.
  h,w=600,500;yy,xx=np.mgrid[:h,:w];rng=np.random.default_rng(12)
  base=209+xx*.03+yy*.018+rng.normal(0,2,(h,w))
  clean=np.stack([base+14,base+7,base-4],axis=2).clip(0,255).astype('uint8')
  image=Image.fromarray(clean);draw=ImageDraw.Draw(image)
  if closed:draw.rectangle((100,70,310,230),outline='black',width=3)
  font=ImageFont.truetype(str(ROOT/'app/font/DejaVuSans-Bold.ttf'),16)
  groups=[];words={}
  for index,(text,xy) in enumerate([('HELLO',(145,100)),('WORLD',(145,135))],1):
   box=draw.textbbox(xy,text,font=font);draw.text(xy,text,font=font,fill='black')
   g=group('a' if index==1 else 'b',box,text,index);groups.append(g);words[g['words'][0]['id']]=ocr_word(g)
  if line:draw.line((155,80,155,220),fill='black',width=3)
  path=Path(folder)/'source.png';image.save(path)
  page={'path':str(path),'sequence':1,'source_name':'source.png','size':[w,h],'sha256':'test'}
  return page,groups,words,clean

 def segment(self,g):
  return {'id':g['id'],'kind':g['kind'],'placement_box':g['box'],'word_box':g['text_box'],'source_word_ids':[w['id'] for w in g['words']]}

 def test_tinted_gradient_groups_by_shared_interior(self):
  with tempfile.TemporaryDirectory() as t:
   page,gs,words,clean=self.fixture(t);before=Path(page['path']).read_bytes();out,info=merge_dialogue_groups(page,gs)
   self.assertEqual(info['merged_blocks'],1);self.assertEqual(out[0]['effective_source'],'HELLO WORLD')
   self.assertEqual({w['id'] for w in out[0]['words']},set(words));self.assertEqual(Path(page['path']).read_bytes(),before)

 def test_unclosed_paper_is_not_a_shared_balloon(self):
  with tempfile.TemporaryDirectory() as t:
   page,gs,words,clean=self.fixture(t,closed=False)
   self.assertEqual(merge_dialogue_groups(page,gs)[1]['merged_blocks'],0)

 def test_rgb_repair_retains_tint_grain_and_untouched_pixels(self):
  with tempfile.TemporaryDirectory() as t:
   page,gs,words,clean=self.fixture(t);out,_=merge_dialogue_groups(page,gs);g=out[0]
   image=Image.open(page['path']).convert('RGB');original=np.asarray(image);seg=self.segment(g)
   mask,repair,safe,bounds,meta=PaperRecovery(image,[seg],words).prepare(seg)
   self.assertEqual(meta['method'],'local_rgb_paper_texture')
   self.assertTrue(np.array_equal(repair[~mask],original[~mask]))
   self.assertGreater(float(np.mean(repair[mask,0].astype(float)-repair[mask,2])),12)
   self.assertLess(float(np.mean(np.abs(repair[mask].astype(float)-clean[mask]))),8)
   self.assertGreater(float(np.std(repair[mask,0].astype(float)-clean[mask,0])),.5)
   # The actual renderer must use this path, one font/size for the whole block.
   record=render_page(page,out,words,{g['id']:{'text':'Hallo Welt'}},str(Path(t)/'out.png'))
   self.assertEqual(record['records'][0]['method'],'local_rgb_paper_texture')
   self.assertEqual(record['records'][0]['status'],'rendered')
   self.assertEqual(record['records'][0]['member_ids'],['a','b'])
   self.assertEqual(record['pixels_changed_outside_calculated_masks'],0)

 def test_source_touching_long_artwork_is_not_erased(self):
  with tempfile.TemporaryDirectory() as t:
   page,gs,words,clean=self.fixture(t,line=True);image=Image.open(page['path']).convert('RGB');before=Path(page['path']).read_bytes()
   g=gs[0];seg=self.segment(g)
   with self.assertRaises(ValueError):PaperRecovery(image,[seg],words).prepare(seg)
   self.assertEqual(before,Path(page['path']).read_bytes())

 def test_completed_joined_translation_reused_across_renderer_update(self):
  with tempfile.TemporaryDirectory() as t:
   source=Path(t)/'source';first=Path(t)/'first';second=Path(t)/'second'
   grouping_fixtures.GroupingTests().make_job(source)
   def reply(service,payload):
    ids=payload['text']['format']['schema']['properties']['translations']['items']['properties']['id']['enum']
    return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'translations':[{'id':i,'text':'Hallo Welt','short_text':None} for i in ids]})}]}]}
   self.assertIn(run(source,first,workers=1,transport=reply)['status'],('completed','completed_with_retained_regions'))
   transport=Mock(side_effect=AssertionError('Existing full source should reuse translation'))
   state=run(first,second,workers=1,transport=transport)
   self.assertIn(state['status'],('completed','completed_with_retained_regions'));transport.assert_not_called()
   self.assertEqual(json.loads((second/'plan.json').read_text())['translation_blocks'],0)

if __name__=='__main__':unittest.main()
