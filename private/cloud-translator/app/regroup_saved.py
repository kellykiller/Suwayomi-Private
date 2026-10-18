"""Rebuild a completed chapter with joined text blocks, preserving the source job."""
from pathlib import Path
import argparse,json,os,shutil,time,zipfile
from concurrent.futures import ProcessPoolExecutor,as_completed
import multiprocessing
from services import Services,JobError,save,digest,filehash
from prepare import raw_words
from text_groups import merge_dialogue_groups,GROUPING_VERSION
from group_translation import translate_changed
from render import render_page,RENDERER_VERSION
from pipeline import report


def render_worker(task):return render_page(*task)


def run(source,output,keys=None,plan_only=False,workers=2,max_openai=160,transport=None):
 source=Path(source).resolve();job=Path(output).resolve()
 if source==job or source.is_relative_to(job):raise JobError('Die neue Ausgabe muss einen eigenen Unterordner erhalten.')
 if (source/'job.lock').exists():raise JobError('Der urspruengliche Kapiteljob laeuft noch.')
 original_state=json.loads((source/'lauf.json').read_text())
 if original_state.get('status') not in ('completed','completed_with_retained_regions'):raise JobError('Gruppierung benoetigt einen abgeschlossenen Kapiteljob. Abgelehnte oder fehlgeschlagene Jobs werden nicht fortgesetzt.')
 if original_state.get('mode')!='live':raise JobError('Bitte einen abgeschlossenen Live-Test verwenden; Offline-Entwuerfe werden hier nicht als API-Uebersetzungen ausgegeben.')
 data=json.loads((source/'ergebnisse.json').read_text());old_targets=json.loads((source/'uebersetzung.json').read_text())['translations']
 source_manifest=json.loads((source/'manifest.json').read_text());model=source_manifest.get('model','gpt-6-astra')
 if not data['pages'] or len(data['pages'])!=data['summary']['input_pages']:raise JobError('Der vorhandene Kapiteljob ist unvollstaendig.')
 job.mkdir(parents=True,exist_ok=True);lock=job/'job.lock'
 try:fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY);os.write(fd,str(os.getpid()).encode());os.close(fd)
 except FileExistsError:raise JobError('Gruppierungsjob ist bereits gesperrt.') from None
 service=Services(job/'api-cache',keys,live=not plan_only,max_openai=max_openai,max_google=0,transport=transport)
 state={'version':original_state['version'],'renderer_version':RENDERER_VERSION,'grouping_version':GROUPING_VERSION,'mode':original_state['mode'],
  'status':'preparing','operation':'regroup_saved','input_pages':len(data['pages']),'model':model};started=time.monotonic();finished=[]
 try:
  signature=digest({'source_manifest':source_manifest,'source_translations':filehash(source/'uebersetzung.json'),'grouping':GROUPING_VERSION,'renderer':RENDERER_VERSION})
  manifest=job/'manifest.json'
  if manifest.exists() and json.loads(manifest.read_text())['signature']!=signature:raise JobError('Der Unterordner gehoert zu einem anderen Gruppierungslauf. Einen anderen Ausgabeordner verwenden.')
  save(manifest,{'signature':signature,'model':model,'grouping_version':GROUPING_VERSION,'source_job':str(source)})
  prepared=[];all_groups=[];changed=[];summaries=[];original_region_count=0
  for old in sorted(data['pages'],key=lambda p:p['sequence']):
   n=old['sequence'];saved=json.loads((source/'prepared'/f'{n:04d}.json').read_text());page=saved['page'];groups=saved.get('original_groups',saved['groups'])
   previous_groups={g['id']:g for g in saved['groups']}
   original=source/'originale'/Path(page['path'].replace('\\','/')).name
   if filehash(original)!=page['sha256']:raise JobError('Originalseite stimmt nicht mit dem gespeicherten Job ueberein.')
   local=job/'originale'/original.name;local.parent.mkdir(exist_ok=True)
   if not local.exists() or filehash(local)!=page['sha256']:shutil.copy2(original,local)
   page['path']=str(local);raw_path=source/'ocr'/f"{page['sha256']}.json";raw=json.loads(raw_path.read_text());_,words=raw_words(raw,page['size'])
   (job/'ocr').mkdir(exist_ok=True);shutil.copy2(raw_path,job/'ocr'/raw_path.name)
   original_region_count+=len(groups)
   merged,summary=merge_dialogue_groups(page,groups);page['assignment_origin']='reviewed_source_plus_closed_region_grouping'
   save(job/'prepared'/f'{n:04d}.json',{'page':page,'groups':merged,'original_groups':groups,'grouping':summary})
   prepared.append((page,merged,words));all_groups.extend(merged);summaries.append({'page':n,**summary})
   for g in merged:
    if g.get('disposition')!='translate':continue
    prior=previous_groups.get(g['id'])
    # Reuse an already joined translation only if the complete source and word
    # membership are unchanged. Splits/reordered/new blocks require fresh text.
    unchanged=prior is not None and prior.get('disposition')=='translate' and \
     {w['id'] for w in prior['words']}=={w['id'] for w in g['words']} and \
     ' '.join(prior.get('effective_source',prior['text']).split())==' '.join(g.get('effective_source',g['text']).split())
    if not unchanged:changed.append(g)
  items=[g for g in all_groups if g['disposition']=='translate'];completed=False
  previous=job/'lauf.json'
  if previous.exists():
   old_state=json.loads(previous.read_text())
   completed=old_state.get('status') in ('completed','completed_with_retained_regions') and (job/'kapitel-de.cbz').exists()
   if completed:
    prior=json.loads((job/'ergebnisse.json').read_text())
    completed=len(prior['pages'])==len(data['pages']) and all((job/'seiten'/p['output_file']).exists() and filehash(job/'seiten'/p['output_file'])==p['output_sha256'] for p in prior['pages'])
  plan={'pages':len(prepared),'new_merged_blocks':sum(len(g.get('member_ids',[]))>1 for g in changed),
   'merged_blocks_total':sum(s['merged_blocks'] for s in summaries),'translation_blocks':len(changed),'original_text_regions':original_region_count,
   'grouped_text_regions':len(all_groups),'new_google_requests':0,'translation_batches':(len(changed)+59)//60,'completed':completed,'model':model}
  save(job/'plan.json',plan);save(job/'gruppierung.json',{'plan':plan,'pages':summaries})
  print(json.dumps(plan,ensure_ascii=False),flush=True)
  if plan_only or completed:return {'status':'planned' if plan_only else 'already_completed','plan':plan}
  state['status']='translation';save(job/'lauf.json',state)
  fresh=translate_changed(changed,items,service,model,job)
  targets={g['id']:fresh[g['id']] if g['id'] in fresh else old_targets.get(g['id'],{'text':None,'short_text':None,'origin':'missing_source_translation'}) for g in items}
  save(job/'uebersetzung.json',{'mode':state['mode'],'model':model,'translations':targets})
  (job/'seiten').mkdir(exist_ok=True);(job/'page-cache').mkdir(exist_ok=True);tasks=[]
  for page,groups,words in prepared:
   dest=job/'seiten'/f"{page['sequence']:04d}.png";cache=job/'page-cache'/f"{page['sequence']:04d}.json"
   key=digest({'renderer':RENDERER_VERSION,'grouping':GROUPING_VERSION,'page':page['sha256'],'groups':groups,'targets':{g['id']:targets.get(g['id']) for g in groups}})
   if cache.exists() and dest.exists():
    cached=json.loads(cache.read_text())
    if cached['key']==key and filehash(dest)==cached['page']['output_sha256']:finished.append(cached['page']);continue
   tasks.append(((page,groups,words,targets,str(dest)),cache,key))
  def keep(task,result):
   save(task[1],{'key':task[2],'page':result});finished.append(result)
   print(f"Seite {result['sequence']:04d}: {result['rendered']} gemeinsame/sonstige Textbereiche eingesetzt. ({len(finished)}/{len(prepared)})",flush=True)
  state['status']='rendering'
  if workers==1:
   for task in tasks:keep(task,render_worker(task[0]))
  else:
   with ProcessPoolExecutor(max_workers=workers,mp_context=multiprocessing.get_context('spawn')) as pool:
    futures={pool.submit(render_worker,task[0]):task for task in tasks}
    for future in as_completed(futures):keep(futures[future],future.result())
  finished.sort(key=lambda p:p['sequence']);temp=job/'kapitel-de.tmp'
  with zipfile.ZipFile(temp,'w',zipfile.ZIP_STORED) as archive:
   for page in finished:archive.write(job/'seiten'/page['output_file'],page['output_file'])
  temp.replace(job/'kapitel-de.cbz');state['status']='completed_with_retained_regions' if any(r['status'] in ('retained_source','retained_unresolved') for p in finished for r in p['records']) else 'completed'
  return state
 except KeyboardInterrupt:
  state['status']='interrupted';state['error']='Abgebrochen. Bestaetigte API-Antworten und fertige Seiten bleiben gespeichert.';return state
 except (JobError,OSError,ValueError,KeyError,AssertionError) as err:
  state['status']='failed';state['error']=str(err);print('FEHLER:',str(err),flush=True);return state
 finally:
  if not plan_only and state['status']!='preparing':
   state.update(seconds=round(time.monotonic()-started,3),new_api_calls=service.new,api_cache_hits=service.hits,api_requests_this_invocation=service.events,completed_pages=len(finished));save(job/'lauf.json',state);report(job,state,finished)
  lock.unlink(missing_ok=True)


def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--plan',action='store_true');parser.add_argument('--key-stdin',action='store_true');parser.add_argument('--workers',type=int,choices=range(1,5),default=2);parser.add_argument('--max-openai',type=int,default=160)
 args=parser.parse_args();keys={}
 if args.key_stdin:
  import sys
  keys=json.loads(sys.stdin.readline())
 try:result=run(args.source,args.output,keys,args.plan,args.workers,args.max_openai)
 except (JobError,OSError,ValueError,KeyError) as err:print('FEHLER:',str(err),flush=True);return 1
 print('Status:',result['status'],flush=True);print('Ausgabe:',args.output,flush=True)
 return 0 if result['status'] in ('planned','already_completed','completed','completed_with_retained_regions') else 1

if __name__=='__main__':raise SystemExit(main())
