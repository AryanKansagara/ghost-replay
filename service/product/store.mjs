import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../schema.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
export class WorkspaceStore {
 constructor(directory){
  const path=resolve(directory);mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw Error('unsafe data directory');
  chmodSync(path,0o700);const file=join(path,'workspace.sqlite');try{if(lstatSync(file).isSymbolicLink())throw Error('unsafe database');}catch(e){if(e.code!=='ENOENT')throw e;}
  this.db=new DatabaseSync(file);chmodSync(file,0o600);this.db.exec(`PRAGMA page_size=4096;PRAGMA secure_delete=ON;PRAGMA busy_timeout=1000;PRAGMA journal_mode=DELETE;PRAGMA auto_vacuum=FULL;PRAGMA max_page_count=8192;
   CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,created TEXT NOT NULL,touched TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS records(workspace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,kind,id));`);
  if(this.db.prepare('PRAGMA page_size').get().page_size!==4096||this.db.prepare('PRAGMA max_page_count').get().max_page_count!==8192){this.db.close();throw Error('database size configuration mismatch');}
  this.prune();this.db.prepare('SELECT 1').get();
 }
 prune(){const cutoff=new Date(Date.now()-30*86400000).toISOString();this.db.prepare('DELETE FROM records WHERE workspace IN(SELECT id FROM workspaces WHERE touched<?)').run(cutoff);this.db.prepare('DELETE FROM workspaces WHERE touched<?').run(cutoff);}
 create(){this.prune();if(this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n>=500)throw new HttpError(503,'storage_capacity','Workspace capacity reached.');
  const workspace={id:randomUUID(),createdAt:new Date().toISOString()};const workspaceToken=randomBytes(32).toString('base64url');this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(workspace.id,digest(workspaceToken),workspace.createdAt,workspace.createdAt);return {workspaceToken,workspace};}
 authenticate(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new HttpError(401,'workspace_required','A valid private workspace token is required.');const row=this.db.prepare('SELECT * FROM workspaces WHERE token=?').get(digest(token));if(!row)throw new HttpError(401,'workspace_required','A valid private workspace token is required.');this.db.prepare('UPDATE workspaces SET touched=? WHERE id=?').run(new Date().toISOString(),row.id);return {id:row.id,createdAt:row.created};}
 list(w,kind){return this.db.prepare('SELECT data FROM records WHERE workspace=? AND kind=? ORDER BY updated DESC,rowid DESC').all(w,kind).map(row=>JSON.parse(row.data));}
 get(w,kind,id){const row=this.db.prepare('SELECT data FROM records WHERE workspace=? AND kind=? AND id=?').get(w,kind,id);if(!row)throw new HttpError(404,'not_found','Saved item not found.');return JSON.parse(row.data);}
 put(w,kind,item){const data=JSON.stringify(item);if(Buffer.byteLength(data)>200000)throw new HttpError(413,'result_too_large','Saved result exceeds the storage limit.');this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET name=excluded.name,updated=excluded.updated,data=excluded.data').run(w,kind,item.id,item.name,item.createdAt,item.updatedAt||item.createdAt,data);
 const keep=kind==='run'?20:10;this.db.prepare('DELETE FROM records WHERE workspace=? AND kind=? AND id NOT IN(SELECT id FROM records WHERE workspace=? AND kind=? ORDER BY updated DESC,rowid DESC LIMIT ?)').run(w,kind,w,kind,keep);return item;}
 delete(w,kind,id){this.get(w,kind,id);this.db.prepare('DELETE FROM records WHERE workspace=? AND kind=? AND id=?').run(w,kind,id);}
 destroy(w){this.db.prepare('DELETE FROM records WHERE workspace=?').run(w);this.db.prepare('DELETE FROM workspaces WHERE id=?').run(w);}
 close(){this.db.close();}
}
