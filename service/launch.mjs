import { mkdirSync, lstatSync, chownSync, chmodSync } from 'node:fs';
import { resolve, parse, join } from 'node:path';
// Railway's empty volume is root-owned. Only this explicitly enabled setup branch
// runs privileged; no HTTP listener or application module exists before setuid.
if(process.env.DROP_PRIVILEGES==='1'){
 try{
  if(process.getuid?.()!==0)throw Error('root initialization required');
  const directory=process.env.DATA_DIR;if(!directory||!directory.startsWith('/data/')||resolve(directory)!==directory||directory==='/data')throw Error('invalid volume directory');
  let current=parse(directory).root;for(const part of directory.split('/').filter(Boolean)){current=join(current,part);try{if(lstatSync(current).isSymbolicLink()||!lstatSync(current).isDirectory())throw Error('unsafe volume path');}catch(e){if(e.code!=='ENOENT')throw e;mkdirSync(current,{mode:0o700});}}
  // The mount itself can arrive root-only; grant traversal, never directory listing.
  if(lstatSync('/data').isSymbolicLink())throw Error('unsafe mount');chmodSync('/data',0o711);
  chownSync(directory,1000,1000);chmodSync(directory,0o700);
  process.setgroups([]);process.setgid(1000);process.setuid(1000);if(process.getuid()!==1000||process.getgid()!==1000)throw Error('privilege drop failed');
 }catch{console.error('{"event":"startup_failed","code":"volume_initialization_failed"}');process.exit(1);}
}else if(process.getuid?.()===0){console.error('{"event":"startup_failed","code":"root_runtime_forbidden"}');process.exit(1);}
await import('./main.mjs');
