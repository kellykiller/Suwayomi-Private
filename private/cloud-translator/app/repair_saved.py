"""Run bounded whole-unit checks on a completed live job, preserving its files."""
from pathlib import Path
import argparse,json,os,shutil,time,zipfile
from services import Services,JobError,save,digest,filehash
from prepare import raw_words
from render import RENDERER_VERSION
from bubble_exceptions import plan_cases,repair_after_render,EXCEPTION_VERSION,MAX_CASES
from pipeline import report


def run(source,output,keys=None,plan_only=False,max_cases=MAX_CASES,max_openai=4,transport=None):
 source=Path(source).resolve();job=Path(output).resolve()
 if source==job or source.is_relative_to(job):raise JobError('Die Ausnahmekorrektur braucht einen eigenen Ausgabeordner.')
 if (source/'job.lock').exists():raise JobError('Der Quelljob laeuft noch.')
 previous=json.loads((source/'lauf.json').read_text())
 if previous.get('status') not in ('completed','completed_with_retained_regions') or previous.get('mode')!='live':
  raise JobError('Nur abgeschlossene Live-Jobs werden geprueft. Fehlgeschlagene oder abgelehnte Jobs werden nicht erneut eingereicht.')
 data=json.loads((source/'ergebnisse.json').read_text());source_manifest=json.loads((source/'manifest.json').read_text())
 old_targets=json.loads((source/'uebersetzung.json').read_text())['translations'];model=source_manifest.get('model',previous.get('model','gpt-6-astra'))
 if len(data['pages'])!=data['summary']['input_pages'] or not data['pages']:raise JobError('Der Quelljob ist unvollstaendig.')
 signature=digest({'source_manifest':source_manifest,'source_results':filehash(source/'ergebnisse.json'),
  'source_translations':filehash(source/'uebersetzung.json'),
  'prepared':[filehash(source/'prepared'/f"{p['sequence']:04d}.json") for p in data['pages']],
  'renderer':RENDERER_VERSION,'exceptions':EXCEPTION_VERSION,'max_cases':max_cases})
 job.mkdir(parents=True,exist_ok=True);lock=job/'job.lock'
 try:fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY);os.write(fd,str(os.getpid()).encode());os.close(fd)
 except FileExistsError:raise JobError('Die Ausnahmekorrektur laeuft bereits.') from None
 service=Services(job/'api-cache',keys,live=not plan_only,max_openai=max_openai,max_google=0,transport=transport)
 state={'version':previous['version'],'renderer_version':RENDERER_VERSION,'exception_version':EXCEPTION_VERSION,'mode':'live',
  'operation':'repair_complete_units','status':'preparing','model':model,'input_pages':len(data['pages'])}
 started=time.monotonic();finished=[];write_state=False
 try:
  manifest=job/'manifest.json'
  if manifest.exists() and json.loads(manifest.read_text())['signature']!=signature:raise JobError('Der Zielordner gehoert zu einer anderen Ausnahmekorrektur. Einen neuen Zielordner verwenden.')
  save(manifest,{'signature':signature,'model':model,'exception_version':EXCEPTION_VERSION,'source_job':str(source)})
  completed=False
  if (job/'lauf.json').exists() and (job/'ergebnisse.json').exists() and (job/'kapitel-de.cbz').exists():
   prior=json.loads((job/'lauf.json').read_text());results=json.loads((job/'ergebnisse.json').read_text())
   completed=prior.get('status') in ('completed','completed_with_retained_regions') and len(results['pages'])==len(data['pages']) and all(
    (job/'seiten'/p['output_file']).is_file() and filehash(job/'seiten'/p['output_file'])==p['output_sha256'] for p in results['pages'])
  if completed:
   plan=json.loads((job/'plan.json').read_text());plan['completed']=True;save(job/'plan.json',plan)
   print(json.dumps(plan,ensure_ascii=False),flush=True);return {'status':'already_completed','plan':plan}
  prepared=[]
  for result in sorted(data['pages'],key=lambda p:p['sequence']):
   n=result['sequence'];stored=json.loads((source/'prepared'/f'{n:04d}.json').read_text());page=stored['page']
   original=source/'originale'/Path(page['path'].replace('\\','/')).name
   if filehash(original)!=page['sha256']:raise JobError('Die Originalseite passt nicht zum gespeicherten Job.')
   path=job/'originale'/original.name;path.parent.mkdir(exist_ok=True)
   if not path.exists() or filehash(path)!=page['sha256']:shutil.copy2(original,path)
   page['path']=str(path);raw_path=source/'ocr'/f"{page['sha256']}.json";_,words=raw_words(json.loads(raw_path.read_text()),page['size'])
   (job/'ocr').mkdir(exist_ok=True);shutil.copy2(raw_path,job/'ocr'/raw_path.name)
   save(job/'prepared'/f'{n:04d}.json',stored);prepared.append((page,stored['groups'],words))
  cases,info=plan_cases(prepared,data['pages'],max_cases)
  plan={'pages':len(prepared),'model':model,'completed':False,**info};save(job/'plan.json',plan)
  print(json.dumps(plan,ensure_ascii=False),flush=True)
  if plan_only:return {'status':'planned','plan':plan}
  state['status']='complete_unit_review';write_state=True;save(job/'lauf.json',state)
  (job/'seiten').mkdir(exist_ok=True)
  for result in data['pages']:
   original=source/'seiten'/result['output_file']
   if filehash(original)!=result['output_sha256']:raise JobError('Die vorhandene Bildausgabe passt nicht zum Quellbericht.')
   shutil.copy2(original,job/'seiten'/result['output_file'])
  save(job/'uebersetzung.json',{'mode':'live','model':model,'translations':old_targets})
  prepared,targets,finished,summary=repair_after_render(prepared,old_targets,data['pages'],service,model,job,max_cases)
  state['exception_review']=summary
  temp=job/'kapitel-de.tmp'
  with zipfile.ZipFile(temp,'w',zipfile.ZIP_STORED) as archive:
   for page in finished:archive.write(job/'seiten'/page['output_file'],page['output_file'])
  temp.replace(job/'kapitel-de.cbz')
  state['status']='completed_with_retained_regions' if any(r['status'] in ('retained_source','retained_unresolved') for p in finished for r in p['records']) else 'completed'
  return state
 except KeyboardInterrupt:
  state.update(status='interrupted',error='Abgebrochen. Bestaetigte Antworten bleiben gespeichert.');return state
 except (JobError,OSError,ValueError,KeyError,AssertionError) as err:
  state.update(status='failed',error=str(err));print('FEHLER:',str(err),flush=True);return state
 finally:
  if write_state:
   state.update(seconds=round(time.monotonic()-started,3),new_api_calls=service.new,api_cache_hits=service.hits,api_requests_this_invocation=service.events,completed_pages=len(finished))
   save(job/'lauf.json',state);report(job,state,finished)
  lock.unlink(missing_ok=True)


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
 p.add_argument('--plan',action='store_true');p.add_argument('--key-stdin',action='store_true');p.add_argument('--max-cases',type=int,choices=range(1,MAX_CASES+1),default=MAX_CASES);p.add_argument('--max-openai',type=int,choices=range(1,17),default=4)
 args=p.parse_args();keys={}
 if args.key_stdin:
  import sys
  keys=json.loads(sys.stdin.readline())
 try:result=run(args.source,args.output,keys,args.plan,args.max_cases,args.max_openai)
 except (JobError,OSError,ValueError,KeyError) as err:print('FEHLER:',str(err),flush=True);return 1
 print('Status:',result['status'],flush=True);print('Ausgabe:',args.output,flush=True)
 return 0 if result['status'] in ('planned','already_completed','completed','completed_with_retained_regions') else 1

if __name__=='__main__':raise SystemExit(main())
