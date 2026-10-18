"""One resumable chapter job: source -> cached OCR -> review -> translation -> PNG/CBZ."""
from pathlib import Path
import argparse,json,sys,time,zipfile,html,shutil,os
from concurrent.futures import ProcessPoolExecutor,as_completed
import multiprocessing
from collections import Counter
from services import Services,save,digest,filehash,JobError
from prepare import collect,read_ocr,groups_for
from language import review,translate,prepare_reviews
from render import render_page,RENDERER_VERSION
from text_groups import merge_dialogue_groups,GROUPING_VERSION
from bubble_exceptions import repair_after_render,EXCEPTION_VERSION

APP=Path(__file__).resolve().parent;VERSION='0.2.0'

def disposition(answer):
 if answer['certainty']!='clear' or answer['needs_more_context'] or answer['reading'] in ('partial','unreadable'):return 'retained_unresolved'
 return {'dialogue':'translate','punctuation':'preserved_punctuation','sfx':'preserved_sfx','background_text':'preserved_background','artwork':'preserved_artwork'}.get(answer['category'],'retained_unresolved')

def report(job,state,pages):
 counts=Counter(r['status'] for p in pages for r in p['records'])
 issues=[]
 for p in pages:
  for r in p['records']:
   if r['status'] in ('retained_source','retained_unresolved'):issues.append({'page':p['sequence'],'id':r['id'],'source':r['source'],'reason':r.get('reason',r.get('classification',{}).get('reason','Ungeklaert'))})
 summary={'version':VERSION,'renderer_version':RENDERER_VERSION,'grouping_version':GROUPING_VERSION,'exception_version':EXCEPTION_VERSION,'exception_review':state.get('exception_review'),'status':state['status'],'mode':state['mode'],'input_pages':state.get('input_pages'),
  'output_pages':len(pages),'region_status':dict(counts),'open_regions':len(issues),'open_region_details':issues,
  'new_api_calls':state.get('new_api_calls',{}),'seconds_this_invocation':state.get('seconds',0),
  'translation_origin':'saved_chat_drafts' if state['mode']=='offline' else 'OpenAI API / validated API cache',
  'image_quality_guaranteed':False,'output_is_partial_translation':bool(issues),
  'warning':'Finished job does not mean error-free translation or perfect retouching. Inspect the reading quality as a whole.'}
 save(job/'ergebnisse.json',{'summary':summary,'pages':pages})
 esc=html.escape;sections=[]
 for p in sorted(pages,key=lambda p:p['sequence']):
  rows=''.join('<tr><td>'+esc(r['id'])+'</td><td>'+esc(r['status'])+'</td><td>'+esc(r['source'])+'</td><td>'+esc(r.get('target') or '')+'</td><td>'+esc(r.get('method') or '')+'</td></tr>' for r in p['records'])
  sections.append(f'<section><h2>Seite {p["sequence"]:04d} – {p["rendered"]} Textbereiche eingesetzt</h2><a href="seiten/{p["output_file"]}"><img loading="lazy" src="seiten/{p["output_file"]}"></a><details><summary>Textbereiche und Status</summary><table><tr><th>ID</th><th>Status</th><th>Quelle</th><th>Ziel</th><th>Verfahren</th></tr>{rows}</table></details></section>')
 banner='OFFLINE-TEST MIT GESPEICHERTEN ENTWÜRFEN' if state['mode']=='offline' else 'AUTOMATISCHER KAPITELJOB'
 doc='''<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kapitel-Automatik</title><style>body{font:16px/1.5 system-ui;max-width:1200px;margin:24px auto;padding:0 18px;background:#eff2f4;color:#142334}section{background:white;padding:16px;margin:18px 0;border-radius:8px}img{display:block;max-width:100%;max-height:1300px;margin:auto}.notice{background:#fff0cf;padding:14px}td,th{text-align:left;vertical-align:top;padding:7px;border-bottom:1px solid #ddd}table{width:100%;border-collapse:collapse}summary{cursor:pointer}</style>'''
 doc+='<h1>'+banner+'</h1><p>Status: '+esc(state['status'])+'</p><p>'+str(len(pages))+' / '+str(state.get('input_pages',0))+' Seiten ausgegeben. '+str(counts['rendered'])+' Textbereiche eingesetzt; '+str(len(issues))+' Bereiche zurückgestellt.</p>'
 doc+='<p class="notice">Zurückgestellte Bereiche enthalten weiter Originaltext. Erhaltene Soundeffekte und Hintergrundbeschriftungen sind nicht deutsch neu gesetzt. Dieser Bericht bestätigt keinen fehlerfreien Textsatz und keine sprachliche Qualitätsfreigabe.</p>'
 if state.get('error'):doc+='<p class="notice">'+esc(state['error'])+'</p>'
 if state['mode']=='offline':doc+='<p>Es wurden gespeicherte, im Chat erzeugte deutsche Entwürfe verwendet. Kein neuer Übersetzungs-API-Lauf.</p>'
 doc+='<p>API-Anfragen in diesem Aufruf: '+esc(str(state.get('new_api_calls',{})))+'.</p>'
 if (job/'kapitel-de.cbz').is_file():doc+='<p><a href="kapitel-de.cbz">CBZ öffnen</a></p>'
 doc+=''.join(sections)+'</html>'; (job/'bericht.html').write_text(doc,encoding='utf-8')
 return summary

def render_worker(arguments):
 page,groups,words,translations,dest=arguments
 return render_page(page,groups,words,translations,dest)

def run(args,keys=None,transport=None):
 job=Path(args.output).resolve();job.mkdir(parents=True,exist_ok=True);seed=Path(args.seed).resolve()
 services=Services(job/'api-cache',keys,live=args.live,max_openai=args.max_openai,max_google=args.max_google,transport=transport)
 state={'version':VERSION,'mode':'live' if args.live else 'offline','status':'preparing','input_pages':0};finished=[];started=time.monotonic()
 lock=job/'job.lock'
 try:
  fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY);os.write(fd,str(os.getpid()).encode());os.close(fd)
 except FileExistsError:raise JobError('Dieser Ausgabeordner ist gesperrt. Einen laufenden Job abwarten; nach einem bestaetigten Absturz job.lock entfernen.') from None
 try:
  pages=collect(args.input,job);state['input_pages']=len(pages)
  signature=digest({'version':VERSION,'mode':state['mode'],'model':args.model,'inputs':[{'name':p['source_name'],'sha':p['sha256']} for p in pages]})
  manifest=job/'manifest.json'
  if manifest.exists() and json.loads(manifest.read_text())['signature']!=signature:raise JobError('Ausgabeordner gehoert zu einem anderen Eingang oder Modus. Anderen Ausgabeordner verwenden.')
  save(manifest,{'signature':signature,'mode':state['mode'],'model':args.model,'input_pages':[{k:v for k,v in p.items() if k!='path'} for p in pages]})
  missing=sum(not (seed/'ocr'/f"{p['sha256']}.json").exists() and not (job/'ocr'/f"{p['sha256']}.json").exists() for p in pages)
  plan={'pages':len(pages),'google_ocr_requests_missing':missing,'mode':state['mode'],'model':args.model,'job_signature':signature}
  save(job/'plan.json',plan)
  print(f'Kapitel: {len(pages)} Seiten, {missing} neue Google-OCR-Anfragen erforderlich.',flush=True)
  if args.plan:return {'status':'planned','plan':plan}
  prepared=[];all_groups=[]
  state['status']='ocr_and_review';save(job/'lauf.json',state)
  for p in pages:
   print(f'OCR / Zuordnung: Seite {p["sequence"]:04d}',flush=True)
   raw=read_ocr(p,seed,services,job);groups,words,origin=groups_for(p,raw,seed);p['assignment_origin']=origin
   if args.live:prepare_reviews(groups,p,seed,job,services,args.model)
   for g in groups:
    answer,review_origin=review(g,p,groups,seed,job,services,args.model,offline=not args.live)
    g['review']=answer;g['review_origin']=review_origin;g['disposition']=disposition(answer)
    g['effective_source']=answer['transcription'] if g['disposition']=='translate' else g['text']
   original_groups=groups
   groups,grouping=merge_dialogue_groups(p,original_groups)
   print(f"  Gruppierung: {grouping['merged_blocks']} gemeinsame Textbloecke",flush=True)
   prepared.append((p,groups,words));all_groups+=groups
   save(job/'prepared'/f"{p['sequence']:04d}.json",{'page':p,'groups':groups,'original_groups':original_groups,'grouping':grouping})
  ids=[g['id'] for g in all_groups]
  if len(ids)!=len(set(ids)):raise JobError('Textbereichs-IDs sind nicht eindeutig.')
  items=[g for g in all_groups if g['disposition']=='translate']
  print(f'{len(items)} Dialog-/Erzaehlbereiche werden mit Kapitelkontext uebersetzt.',flush=True)
  state['status']='translation';save(job/'lauf.json',state)
  targets=translate(items,seed,job,services,args.model,offline=not args.live,batch_size=args.batch_size)
  if not args.live:
   for group in items:
    if len(group.get('member_ids',[]))>1:targets[group['id']]={'text':None,'short_text':None,'origin':'merged_block_requires_new_translation'}
  save(job/'uebersetzung.json',{'mode':state['mode'],'model':args.model,'translations':targets})
  state['status']='rendering';(job/'seiten').mkdir(exist_ok=True);(job/'page-cache').mkdir(exist_ok=True)
  todo=[]
  for page,groups,words in prepared:
   filename=f"{page['sequence']:04d}.png";dest=job/'seiten'/filename
   key=digest({'renderer_version':VERSION+'/'+RENDERER_VERSION,'page':page['sha256'],'groups':groups,'targets':{g['id']:targets.get(g['id']) for g in groups}})
   cache=job/'page-cache'/f"{page['sequence']:04d}.json"
   if cache.exists() and dest.exists():
    entry=json.loads(cache.read_text())
    if entry['key']==key and entry['page']['output_sha256']==filehash(dest):finished.append(entry['page']);continue
   todo.append((page,groups,words,targets,str(dest),cache,key))
  if args.workers==1:
   for page,groups,words,targets,dest,cache,key in todo:
    result=render_page(page,groups,words,targets,dest);save(cache,{'key':key,'page':result});finished.append(result)
    print(f'Bild {page["sequence"]:04d}: {result["rendered"]} eingesetzt, {result["unresolved_dialogue"]} Dialogbereiche erhalten.',flush=True)
    state['completed_pages']=len(finished);save(job/'lauf.json',state)
  else:
   with ProcessPoolExecutor(max_workers=args.workers,mp_context=multiprocessing.get_context('spawn')) as pool:
    futures={pool.submit(render_worker,task[:5]):task for task in todo}
    for future in as_completed(futures):
     task=futures[future];result=future.result();save(task[5],{'key':task[6],'page':result});finished.append(result)
     print(f'Bild {result["sequence"]:04d}: {result["rendered"]} eingesetzt, {result["unresolved_dialogue"]} Dialogbereiche erhalten. ({len(finished)}/{len(pages)})',flush=True)
     state['completed_pages']=len(finished);save(job/'lauf.json',state)
  if args.live:
   state['status']='complete_unit_review';save(job/'lauf.json',state)
   prepared,targets,finished,exception_summary=repair_after_render(prepared,targets,finished,services,args.model,job)
   state['exception_review']=exception_summary
  finished.sort(key=lambda p:p['sequence'])
  temp=job/'kapitel-de.tmp'
  with zipfile.ZipFile(temp,'w',zipfile.ZIP_STORED) as archive:
   for p in finished:archive.write(job/'seiten'/p['output_file'],p['output_file'])
  temp.replace(job/'kapitel-de.cbz');state['status']='completed_with_retained_regions' if any(r['status'] in ('retained_source','retained_unresolved') for p in finished for r in p['records']) else 'completed'
  return state
 except KeyboardInterrupt:
  state['status']='interrupted';state['error']='Abgebrochen. Abgeschlossene API-Antworten bleiben gespeichert.';return state
 except (JobError,ValueError,AssertionError,OSError) as error:
  state['status']='failed';state['error']=str(error);print('FEHLER:',str(error),flush=True);return state
 finally:
  state['seconds']=round(time.monotonic()-started,3);state['new_api_calls']=services.new;state['api_cache_hits']=services.hits
  state['api_requests_this_invocation']=services.events;save(job/'lauf.json',state)
  if not args.plan:report(job,state,finished)
  lock.unlink(missing_ok=True)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
 p.add_argument('--seed',type=Path,default=APP.parent/'seed');p.add_argument('--live',action='store_true');p.add_argument('--plan',action='store_true')
 p.add_argument('--key-stdin',action='store_true');p.add_argument('--model',default='gpt-6-astra')
 p.add_argument('--workers',type=int,choices=range(1,5),default=2);p.add_argument('--batch-size',type=int,default=60)
 p.add_argument('--max-openai',type=int,default=160);p.add_argument('--max-google',type=int,default=100)
 args=p.parse_args()
 if not 1<=args.batch_size<=80 or not 1<=args.max_openai<=256 or not 1<=args.max_google<=100:p.error('Ungueltige Anfragegrenzen.')
 keys={}
 if args.live and not args.plan:
  if args.key_stdin:
   try:keys=json.loads(sys.stdin.readline())
   except ValueError:p.error('API-Schluesseleingabe unlesbar.')
  else:keys={'openai':os.environ.get('OPENAI_API_KEY'),'google':os.environ.get('GOOGLE_VISION_API_KEY')}
 try:result=run(args,keys)
 except JobError as err:print(str(err),file=sys.stderr);return 1
 print('Ausgabe:',args.output,flush=True);print('Status:',result['status'],flush=True)
 return 0 if result['status'] in ('completed','completed_with_retained_regions','planned') else 1
if __name__=='__main__':raise SystemExit(main())
