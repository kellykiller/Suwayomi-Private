"""Translate only newly joined blocks, with all chapter dialogue as context."""
import json
from pathlib import Path
import language
from services import json_request,parse_openai,save,JobError


def translate_changed(changed,all_items,services,model,job,batch_size=60):
 context=json.dumps({'chapter':[{'id':g['id'],'page':g['page_sequence'],'source_text':g['effective_source'],'box':g['text_box']} for g in all_items]},ensure_ascii=False)
 result={}
 for start in range(0,len(changed),batch_size):
  batch=changed[start:start+batch_size];ids=[g['id'] for g in batch]
  row={'type':'object','properties':{'id':{'type':'string','enum':ids},'text':{'type':['string','null']},'short_text':{'type':['string','null']}},'required':['id','text','short_text'],'additionalProperties':False}
  schema={'type':'object','properties':{'translations':{'type':'array','items':row}},'required':['translations'],'additionalProperties':False}
  content=[{'type':'input_text','text':context},{'type':'input_text','text':json.dumps({'target_batch':[{'id':g['id'],'source_text':g['effective_source']} for g in batch]},ensure_ascii=False)}]
  print(f"Neue gemeinsame Textbloecke uebersetzen: {start+1} bis {start+len(batch)} von {len(changed)}",flush=True)
  raw=services.call('openai',json_request(model,'german_comic_translation',schema,language.TRANSLATE_PROMPT,content,12288));answer=parse_openai(raw)
  rows=answer.get('translations',[]) if isinstance(answer,dict) else []
  if hasattr(language,'translation_reply_error'):
   error=language.translation_reply_error(rows,ids)
   if error:raise JobError(error)
  if not isinstance(rows,list) or any(not isinstance(r,dict) or not isinstance(r.get('id'),str) for r in rows) or len(rows)!=len(ids) or {r['id'] for r in rows}!=set(ids):raise JobError('Neue Blockuebersetzung ohne vollstaendige eindeutige IDs. Keine automatische Wiederholung.')
  for r in rows:
   if set(r)!={'id','text','short_text'} or any(r[k] is not None and not isinstance(r[k],str) for k in ('text','short_text')):raise JobError('Neue Blockuebersetzung hat ungueltige Textfelder.')
   result[r['id']]={**r,'origin':'joined_block_api_or_cache'}
  save(Path(job)/'translations-progress.json',result)
 return result
