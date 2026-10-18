"""HTTP services and durable request cache. Never persists credentials."""
from pathlib import Path
import json,hashlib,urllib.request,urllib.error,time

class JobError(Exception):pass
class AmbiguousRequest(JobError):pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None

def save(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_name(path.name+'.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def filehash(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def parse_openai(response):
 if not isinstance(response,dict) or response.get('status')!='completed':raise JobError('OpenAI-Antwort unvollstaendig; Ergebnis bleibt unveraendert.')
 texts=[]
 for item in response.get('output',[]):
  if item.get('type')!='message':continue
  for part in item.get('content',[]):
   if part.get('type')=='refusal':raise JobError('OpenAI hat eine Anfrage abgelehnt.')
   if part.get('type')=='output_text':texts.append(part['text'])
 if len(texts)!=1:raise JobError('OpenAI liefert keine eindeutige JSON-Antwort.')
 try:return json.loads(texts[0])
 except ValueError:raise JobError('OpenAI-Antwort ist kein lesbares JSON.') from None

class Services:
 def __init__(self,cache,keys=None,live=False,max_openai=160,max_google=100,transport=None):
  self.cache=Path(cache);self.cache.mkdir(parents=True,exist_ok=True);self.keys=keys or {};self.live=live
  self.limits={'openai':max_openai,'google':max_google};self.transport=transport or self.http
  self.events=[];self.new={'openai':0,'google':0};self.hits=0
 def http(self,service,payload):
  key=self.keys.get(service)
  if not isinstance(key,str) or not key.strip():raise JobError(service+': API-Schluessel fehlt.')
  url='https://api.openai.com/v1/responses' if service=='openai' else 'https://vision.googleapis.com/v1/images:annotate'
  headers={'Content-Type':'application/json'}
  if service=='openai':headers['Authorization']='Bearer '+key
  else:headers['X-Goog-Api-Key']=key
  request=urllib.request.Request(url,data=json.dumps(payload,ensure_ascii=False).encode(),headers=headers,method='POST')
  try:
   with urllib.request.build_opener(NoRedirect()).open(request,timeout=180) as response:
    raw=response.read(32*1024*1024+1)
    if len(raw)>32*1024*1024:raise JobError('API-Antwort zu gross.')
    return json.loads(raw)
  except urllib.error.HTTPError as err:
   # No response body or headers: errors can echo credentials.
   raise JobError(f'{service}: HTTP {err.code}. Zugang, Guthaben oder Modell pruefen; keine automatische HTTP-Wiederholung.') from None
  except (urllib.error.URLError,TimeoutError,OSError):
   raise AmbiguousRequest(service+': Netzwerkfehler oder Zeitlimit. Bearbeitungsstatus unbekannt; keine automatische Wiederholung.') from None
  except ValueError:raise JobError('API-Antwort unlesbar.') from None
 def call(self,service,payload):
  fingerprint=digest({'service':service,'payload':payload});path=self.cache/service/(fingerprint+'.json');marker=path.with_suffix('.pending')
  if path.exists():self.hits+=1;return json.loads(path.read_text())
  if marker.exists():raise AmbiguousRequest('Eine fruehere Anfrage hat keinen bestaetigten Abschluss: '+fingerprint[:12]+'. Keine automatische Doppelanfrage.')
  if not self.live:raise JobError('Offline: angefragtes API-Ergebnis fehlt im Cache.')
  existing=len(list((self.cache/service).glob('*.json')))+len(list((self.cache/service).glob('*.pending')))
  if existing>=self.limits[service]:raise JobError(service+': Anfragegrenze fuer diesen Job erreicht.')
  save(marker,{'service':service,'fingerprint':fingerprint,'started_unix':time.time()})
  self.new[service]+=1;started=time.monotonic()
  try:result=self.transport(service,payload)
  except AmbiguousRequest:raise
  except JobError:
   marker.unlink(missing_ok=True);raise
  except Exception:
   raise AmbiguousRequest(service+': Anfrage ohne bestaetigtes Ergebnis. Keine automatische Wiederholung.') from None
  save(path,result);marker.unlink(missing_ok=True)
  self.events.append({'service':service,'request_fingerprint':fingerprint,'seconds':round(time.monotonic()-started,3),'usage':result.get('usage')})
  return result

def json_request(model,name,schema,instructions,input_content,max_tokens=8192):
 return {'model':model,'store':False,'reasoning':{'effort':'medium'},'max_output_tokens':max_tokens,
  'instructions':instructions,'input':[{'role':'user','content':input_content}],
  'text':{'format':{'type':'json_schema','name':name,'strict':True,'schema':schema}}}
