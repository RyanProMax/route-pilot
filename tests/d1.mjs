import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function database() {
  const sql=new DatabaseSync(':memory:');
  for(const name of ['0004_private_control.sql','0005_google_accounts.sql','0006_admin_console.sql'])
    sql.exec(readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8'));
  sql.exec('CREATE TABLE reports(minute INTEGER,ts INTEGER,metrics TEXT)');
  const DB={prepare(query){let args=[];return {
    bind(...a){args=a;return this;},async first(){return sql.prepare(query).get(...args)??null;},
    async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};},
  };},async batch(statements){sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.all());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,DB};
}
