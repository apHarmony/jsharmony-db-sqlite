﻿/*
Copyright 2017 apHarmony

This file is part of jsHarmony.

jsHarmony is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

jsHarmony is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this package.  If not, see <http://www.gnu.org/licenses/>.
*/

/*
Notes:
1. Don't use ";" in any queries except as a statement terminator.
   For example, don't use a raw ";" in any strings.
   If ";" is used, it must be escaped as \;
   The escape function automatically handles escaping ; characters
2. Errors are generated by updating jsharmony_meta(errcode, errmsg)
   Notices have an errcode of -1
   Warnings have an errcode of -2
*/

var DB = require('jsharmony-db');
var types = DB.types;
var sqlite3 = require('sqlite3');
var _ = require('lodash');
var async = require('async');
var moment = require('moment');
var crypto = require('crypto');
var typeHandler = require('./DB.sqlite.types.js');
var path = require('path');

//Locks
//usage: lock('lockname',function(release){ /* actions */ release(); });
var _locks = {};
function lock(id, f){
  if(id in _locks){ setTimeout(function(){ lock(id, f); }, 1); }
  else {
    _locks[id] = true;
    f(function(){ delete _locks[id]; });
  }
}

var _INIT_COMPLETE = '%%%INITCOMPLETE%%%';

function DBdriver() {
  this.name = 'sqlite';
  this.sql = require('./DB.sqlite.sql.js');
  this.meta = require('./DB.sqlite.meta.js');
  this.connectsql = "drop table if exists jsharmony_meta;";
  this.initsql = "\
    pragma foreign_keys = ON; \
    create table if not exists jsharmony_meta as select 'USystem' context,0 errcode,'' errmsg,'' jsexec,null as audit_seq,0 extra_changes, null last_insert_rowid_override; \
    "+_INIT_COMPLETE+";\
    ";
  this.dbpool = {};
  this.timeout = 10000;
  this.silent = false;

  //Initialize platform
  this.platform = {
    Log: function(msg){ console.log(msg); }, // eslint-disable-line no-console
    Config: {
      debug_params: {
        db_log_level: 6,           //Bitmask: 2 = WARNING, 4 = NOTICES :: Database messages logged to the console / log
        db_error_sql_state: false  //Log SQL state during DB error
      }
    }
  };
  this.platform.Log.info = function(msg){ console.log(msg); }; // eslint-disable-line no-console
  this.platform.Log.warning = function(msg){ console.log(msg); }; // eslint-disable-line no-console
  this.platform.Log.error = function(msg){ console.log(msg); }; // eslint-disable-line no-console
}

DBdriver.prototype.getDefaultSchema = function(){
  return '';
};

DBdriver.prototype.logRawSQL = function(sql){
  if (this.platform.Config.debug_params && this.platform.Config.debug_params.db_raw_sql && this.platform.Log) {
    this.platform.Log.info(sql, { source: 'database_raw_sql' });
  }
};

DBdriver.prototype.Init = function (cb) { if(cb) return cb(); };

DBdriver.prototype.Close = function(onClosed, options){
  options = _.extend({ force: false }, options);
  var _this = this;
  //If no remaining connections, run the callback
  if(_.isEmpty(_this.dbpool)){ if(onClosed) onClosed(); }
  //Close the connections, one at a time
  for(var conid in _this.dbpool){
    _this.dbpool[conid].DeferClose({ clearTimeout: true });
    _this.dbpool[conid].close(function(){
      //Remove the connection from the pool
      delete _this.dbpool[conid];
      //Rerun the Close function to target the next connection
      _this.Close(onClosed, options);
    });
    break;
  }
};

DBdriver.prototype.getDBParam = function (dbtype, val) {
  var _this = this;
  if (!dbtype) throw new Error('Cannot get dbtype of null object');
  if (val === null) return 'NULL';
  if (typeof val === 'undefined') return 'NULL';
  
  if ((dbtype.name == 'VarChar') || (dbtype.name == 'Char')) {
    var valstr = val.toString();
    if ((dbtype.length == types.MAX) || (dbtype.length == -1)) return "cast('" + _this.escape(valstr) + "' as text)";
    return "cast('" + _this.escape(valstr.substring(0, dbtype.length)) + "' as text)";
  }
  else if (dbtype.name == 'VarBinary') {
    var valbin = null;
    if (val instanceof Buffer) valbin = val;
    else valbin = new Buffer(val.toString());
    if (valbin.length == 0) return "NULL";
    return "X'" + valbin.toString('hex').toLowerCase() + "'";
  }
  else if ((dbtype.name == 'BigInt') || (dbtype.name == 'Int') || (dbtype.name == 'SmallInt') || (dbtype.name == 'TinyInt')) {
    var valint = parseInt(val);
    if (isNaN(valint)) { return "NULL"; }
    return valint.toString();
  }
  else if (dbtype.name == 'Boolean') {
    if((val==='')||(typeof val == 'undefined')) return "NULL";
    if(typeHandler.boolParser(val)) return '1';
    return '0';
  }
  else if (dbtype.name == 'Decimal') {
    let valfloat = parseFloat(val);
    if (isNaN(valfloat)) { return "NULL"; }
    return "cast('" + _this.escape(val.toString()) + "' as numeric)";
  }
  else if (dbtype.name == 'Float') {
    let valfloat = parseFloat(val);
    if (isNaN(valfloat)) { return "NULL"; }
    return "cast('" + _this.escape(val.toString()) + "' as real)";
  }
  else if ((dbtype.name == 'Date') || (dbtype.name == 'Time') || (dbtype.name == 'DateTime')) {
    var suffix = '';

    var valdt = null;
    if (val instanceof Date) { valdt = val; }
    else if(_.isNumber(val) && !isNaN(val)){
      valdt = moment(moment.utc(val).format('YYYY-MM-DDTHH:mm:ss.SSS'), "YYYY-MM-DDTHH:mm:ss.SSS").toDate();
    }
    else {
      if (isNaN(Date.parse(val))) return "NULL";
      valdt = new Date(val);
    }

    var mdate = moment(valdt);
    if (!mdate.isValid()) return "NULL";

    if(!_.isNumber(val)){
      //Convert to local on timestamptz and timetz
      if('jsh_utcOffset' in val){
        //Time is in UTC, Offset specifies amount and timezone
        var neg = false;
        if(val.jsh_utcOffset < 0){ neg = true; }
        suffix = moment.utc(new Date(val.jsh_utcOffset*(neg?-1:1)*60*1000)).format('HH:mm');
        //Reverse offset
        suffix = ' '+(neg?'+':'-')+suffix;

        mdate = moment.utc(valdt);
        mdate = mdate.add(val.jsh_utcOffset*-1, 'minutes');
      }

      if('jsh_microseconds' in val){
        var ms_str = "000"+(Math.round(val.jsh_microseconds)).toString();
        ms_str = ms_str.slice(-3);
        suffix = ms_str.replace(/0+$/,'') + suffix;
      }
    }

    var rslt = '';
    if (dbtype.name == 'Date') rslt = "'" + mdate.format('YYYY-MM-DD') + "'";
    else if (dbtype.name == 'Time') rslt = "'" + mdate.format('HH:mm:ss.SSS') + suffix + "'";
    else rslt = "'" + mdate.format('YYYY-MM-DD HH:mm:ss.SSS') + suffix + "'";
    return rslt;
  }
  else if ((dbtype.name == 'Raw')) {
    return val.toString();
  }
  throw new Error('Invalid datatype: ' + JSON.stringify(dbtype));
};

DBdriver.prototype.ExecSession = function (dbtrans, dbconfig, session) {
  var _this = this;
  
  if (dbtrans) {
    session(null, dbtrans.con, '', function () { /* Do nothing */ });
  }
  else {
    if(!dbconfig) throw new Error('dbconfig is required');
    var onRelease = function(con, release){
      return function () {
        //Do not close in-memory databases
        if(dbconfig.database == ':memory:') return release();
        con.DeferClose();
        return release();
        
      };
    };
    if(path.basename(dbconfig.database)=='___DB_NAME___'){
      _this.platform.Log.error('Unconfigured database');
      throw new Error('Unconfigured database');
    }
    lock(dbconfig.database, function(release){
      if(dbconfig.database in _this.dbpool){
        let con = _this.dbpool[dbconfig.database];
        con.DeferClose({ clearTimeout: true });
        return session(null, con, _this.initsql + (dbconfig._presql || ''), onRelease(con, release));
      }
      else {
        let con = new sqlite3.Database(dbconfig.database, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, function(err){
          _this.logRawSQL(_this.connectsql);
          if (err) { setTimeout(function(){ con.close(); release(); },1); return _this.ExecError(err, session, "DB Connect Error: "+err.toString()); }
          con.run(_this.connectsql, function(err, stmt_rslt){
            if (err) { setTimeout(function(){ con.close(); release(); },1); return _this.ExecError(err, session, "DB Connect Error: "+err.toString()); }
            _this.dbpool[dbconfig.database] = con;
            con.DeferClose = DB.util.waitDefer(function(){
              con.close(function(){
                delete _this.dbpool[dbconfig.database];
              });
            }, _this.timeout);
            session(null, con, _this.initsql + (dbconfig._presql || ''), onRelease(con, release));
          });
        });
      }
    });
  }
};

DBdriver.prototype.ExecError = function(err, callback, errprefix) {
  var errMsg = '';
  if(err){
    if(err.message && (err.message.indexOf('SQLITE_CONSTRAINT: Application Error')==0)) err.message = err.message.substr(19);
    else if(err.message && (err.message.indexOf('SQLITE_CONSTRAINT: Application Warning')==0)) err.message = err.message.substr(19);
    else if(err.message && (err.message.indexOf('SQLITE_CONSTRAINT: Execute Form')==0)) err.message = err.message.substr(19);
    if(err.number && err.message) errMsg = 'Error '+err.number + ': ' + err.message;
    else errMsg = err.toString();
  }
  if (this.platform.Config.debug_params.db_error_sql_state && !this.silent) this.platform.Log((errprefix || '') + errMsg, { source: 'database' });
  if (callback) return callback(err, null);
  else throw err;
};

function splitSQL(fsql){
  var sql = [];
  var lastidx=fsql.lastIndexOf('%%%JSEXEC_ESCAPE(');
  //Escape JSEXEC expressions
  while(lastidx >= 0){
    var endPos = fsql.indexOf(')%%%',lastidx);
    if(endPos >= 0){
      var match = fsql.substr(lastidx,endPos-lastidx+4);
      var expr = match.substr(17);
      expr = expr.substr(0,expr.length-4);
      expr = expr.replace(/'/g,"''").replace(/\\;/g,"\\\\\\;").replace(/\r/g," ").replace(/\n/g,"\\n ");
      fsql = fsql.substr(0,lastidx) + expr + fsql.substr(lastidx+match.length);
    }
    if(lastidx == 0) lastidx = -1;
    else lastidx=fsql.lastIndexOf('%%%JSEXEC_ESCAPE(',lastidx-1);
  }
  while(fsql){
    var nexts = fsql.indexOf(';');
    while((nexts > 0) && (fsql[nexts-1]=="\\")) nexts = fsql.indexOf(';', nexts+1);
    if(nexts < 0){ sql.push(fsql.trim()); fsql = ''; }
    else if(nexts==0) fsql = fsql.substr(1);
    else{ sql.push(fsql.substr(0,nexts).trim()); fsql = fsql.substr(nexts+1); }
  }
  for(var i=0;i<sql.length;i++){
    var stmt = sql[i].trim();
    //Remove starting comments
    while((stmt.indexOf('/*')==0)||(stmt.indexOf('//')==0)||(stmt.indexOf('--')==0)){
      if((stmt.indexOf('//')==0)||(stmt.indexOf('--')==0)){
        var eolpos = stmt.indexOf('\n');
        if(eolpos >= 0) stmt = stmt.substr(eolpos+1);
        else stmt = '';
      }
      else if(stmt.indexOf('/*')==0){
        var eoc = stmt.indexOf('*/');
        if(eoc >= 0) stmt = stmt.substr(eoc+2);
        else stmt = '';
      }
      stmt = stmt.trim();
    }
    //Remove empty statements
    var is_empty = stmt.match(/^(\s)*$/);
    var is_comment = stmt.match(/^(\s)*\/\//);
    is_comment = is_comment || stmt.match(/^(\s)*--/);
    if(is_empty || is_comment){
      sql.splice(i,1);
      i--;
      continue;
    }
    stmt = DB.util.ReplaceAll(stmt, "\\;", ';');
    sql[i] = stmt;
  }
  return sql;
}

DBdriver.prototype.ExecConSQL = function(con, sql, cb){
  this.logRawSQL(sql);
  return con.all(sql, cb);
};

function getSalt(len){
  var rslt = '';
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=][}{|~,.<>?';
  for(var i=0;i<len;i++) rslt += chars.charAt(Math.floor(Math.random()*chars.length));
  return rslt;
}

DBdriver.prototype.ExecQuery = function(con, sql, conComplete, callback, processor) {
  var _this = this;

  //Split SQL into an array
  sql = splitSQL(sql);

  //Set start_idx
  var start_idx = 0;
  for(var i=0;i<sql.length;i++){
    if(!start_idx && (sql[i] == _INIT_COMPLETE)){
      start_idx = i;
      sql.splice(i,1);
      i--;
    }
  }

  //console.log(sql); //Log all SQL statements for debugging

  //Run SQL
  var notices = [];
  //var startTime = Date.now();
  var rslt = [];
  var idx = 0;

  var last_stmt = '';

  async.eachSeries(sql, function(stmt, stmt_cb){
    idx++;
    var is_select = stmt.match(/^(\s)*(select|with)/gi);
    var is_pragma = stmt.match(/^(\s)*(pragma)/gi);
    last_stmt = stmt;
    //var startdt = Date.now();
    _this.ExecConSQL(con, stmt, function (err, stmt_rslt) {
      //Statement Execution Monitoring
      //console.log('Statement '+idx+': '+(Date.now()-startdt));
      //if((Date.now()-startdt)>25) console.log(stmt);
      if(idx > start_idx){
        if(is_select) rslt.push(stmt_rslt);
        else if(is_pragma && stmt_rslt && stmt_rslt.length) rslt.push(stmt_rslt);
      }
      if(err) { /* Do nothing */ } //Don't check for jsharmony_meta(errcode) if err was generated by statement
      else if(idx <= start_idx) { /* Do nothing */ } //Don't check for jsharmony_meta(errcode) before jsharmony_meta is initialized
      else return _this.ExecConSQL(con, "select errcode, errmsg, jsexec from jsharmony_meta", function(err, stmt_rslt){
        idx++;
        if(err) return stmt_cb(err);
        else if(!stmt_rslt || !stmt_rslt.length) return stmt_cb(new Error('No data returned from jsharmony_meta'));
        else if(stmt_rslt[0].errcode && (stmt_rslt[0].errcode==-1)){ notices.push(new DB.Message(DB.Message.NOTICE, stmt_rslt[0].errmsg)); }
        else if(stmt_rslt[0].errcode && (stmt_rslt[0].errcode==-2)){ notices.push(new DB.Message(DB.Message.WARNING, stmt_rslt[0].errmsg)); }
        else if(stmt_rslt[0].errcode) return stmt_cb({ number: stmt_rslt[0].errcode, message: stmt_rslt[0].errmsg });
        if(!stmt_rslt[0].jsexec) return stmt_cb(null);

        //Execute jsexec function
        var strexec = stmt_rslt[0].jsexec.toString().trim();
        if(strexec.substr(strexec.length-1,1)==',') strexec = strexec.substr(0,strexec.length-1);
        strexec = '['+strexec+']';
        var jsexec = null;
        try{
          jsexec = JSON.parse(strexec);
        }
        catch(ex){
          return stmt_cb(new Error('Error parsing jsharmony_meta jsexec command: '+strexec));
        }
        async.eachSeries(jsexec, function(jscmd, jsexec_cb){
          if(!jscmd) return jsexec_cb(null);
          var jscmdstr = JSON.stringify(jscmd);
          if(!jscmd.function) return jsexec_cb(new Error('jsharmony_meta jsexec command missing function: '+jscmdstr));
          var f = jscmd.function;
          if((f=='sha1')||(f=='sha256')){
            //{ "function": "sha1", "table": "jsharmony_pe", "rowid": '||NEW.rowid||', "source":"pe_id||pe_pw1||(select pp_val from jsharmony_v_pp where PP_PROCESS=''USERS'' and PP_ATTRIB=''HASH_SEED_S'')", "dest":"pe_hash" }
            //{ "function": "sha256", "table": "jsharmony_pe", "rowid": '||NEW.rowid||', "source":"pe_id||pe_pw1||(select pp_val from jsharmony_v_pp where PP_PROCESS=''USERS'' and PP_ATTRIB=''HASH_SEED_S'')", "dest":"pe_hash" }
            if(!jscmd.table) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "table" parameter: '+jscmdstr));
            if(!jscmd.rowid) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "rowid" parameter: '+jscmdstr));
            if(!jscmd.source && !jscmd.random) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "source" parameter: '+jscmdstr));
            if(!jscmd.dest) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "dest" parameter: '+jscmdstr));
            var getHash = function(seed){
              var rslt = crypto.createHash(f).update((seed||'').toString()).digest();
              if(jscmd.substring && parseInt(jscmd.substring)) rslt = rslt.slice(0,parseInt(jscmd.substring));
              return rslt;
            };
            var getSource = function(source_cb){
              _this.ExecConSQL(con, "select ("+jscmd.source+") as hash from "+jscmd.table+" where rowid="+_this.getDBParam(types.BigInt,jscmd.rowid), function(err, cmd_rslt){
                if(err) return jsexec_cb(err);
                if(!cmd_rslt.length) return jsexec_cb(new Error('jsharmony_meta jsexec No results for hash source'));
                var hash = getHash(cmd_rslt[0]['hash']||'');
                return source_cb(hash);
              });
            };
            if(jscmd.random){
              getSource = function(source_cb){
                var hash = getHash(getSalt(256));
                //Check if hash exists
                _this.ExecConSQL(con, "select ("+jscmd.dest+") as hash from "+jscmd.table+" where "+jscmd.dest+"="+_this.getDBParam(types.VarBinary(types.MAX),hash), function(err, cmd_rslt){
                  if(err) return jsexec_cb(err);
                  //If hash collision, retry
                  if(cmd_rslt.length) return getSource(source_cb);
                  return source_cb(hash);
                });
              };
            }
            getSource(function(hash){
              _this.ExecConSQL(con, "update "+jscmd.table+" set "+jscmd.dest+"="+_this.getDBParam(types.VarBinary(types.MAX),hash)+" where rowid="+_this.getDBParam(types.BigInt,jscmd.rowid), jsexec_cb);
            });
          }
          else if(f=='soundex'){
            //{ "function": "soundex", "source": "(select c_name from c where c_id='||NEW.c_id||')", "dest": "insert into sdx(table_name,field_name,table_id,sdx_word,sdx_val) values(''c'',''c_name'','||NEW.c_id||',(select c_name from c where c_id='||NEW.c_id||'),%%%SOUNDEX%%%)" }
            if(!jscmd.source) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "source" parameter: '+jscmdstr));
            if(!jscmd.dest) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "dest" parameter: '+jscmdstr));
            _this.ExecConSQL(con, "select ("+jscmd.source+") as soundex", function(err, cmd_rslt){
              if(err) return jsexec_cb(err);
              if(!cmd_rslt.length) return jsexec_cb(new Error('jsharmony_meta jsexec No results for soundex source'));
              var soundex = DB.util.Soundex(cmd_rslt[0]['soundex']||'');
              _this.ExecConSQL(con, DB.util.ReplaceAll(jscmd.dest, '%%%SOUNDEX%%%', _this.getDBParam(types.VarChar(types.MAX),soundex)), jsexec_cb);
            });
          }
          else if(f=='exec'){
            //{ "function": "exec", "sql": "update jsharmony_pe set pe_pw1=null,pe_pw2=null where rowid='||NEW.rowid||'" }
            if(!jscmd.sql) return jsexec_cb(new Error('jsharmony_meta jsexec command missing "sql" parameter: '+jscmdstr));
            var fsql = splitSQL(jscmd.sql);
            async.eachSeries(fsql, function(fsql_stmt,fsql_cb){
              last_stmt = fsql_stmt;
              _this.ExecConSQL(con, fsql_stmt, fsql_cb);
            }, jsexec_cb);
          }
          else return jsexec_cb(new Error('jsharmony_meta jsexec invalid function: '+jscmdstr));
        }, function(err){
          if(err) return stmt_cb(err);
          _this.ExecConSQL(con, "update jsharmony_meta set jsexec=''", stmt_cb);
        });
      });
      stmt_cb(err);
    });
  },function(err){
    //var totTime = Date.now()-startTime;
    //console.log('Executed '+idx+' statements');
    //console.log('Time: '+totTime+'ms');
    //console.log(Math.round(totTime/idx) + 'ms per statement');
    //console.log(sql);
    //console.log(rslt); //Log all SQL results for debugging

    conComplete();
    if (err) { return _this.ExecError(err, callback, 'SQL Error: ' + last_stmt + ' :: '); }
    _this.postProcessDataTypes(rslt);
    processor(rslt, notices);
  });
};

DBdriver.prototype.postProcessDataTypes = function(dbrslt){
  if(!dbrslt || !dbrslt.length) return;
  for(var i=0;i<dbrslt.length;i++){
    var dbtbl = dbrslt[i];
    if(!dbtbl || !dbtbl.length) continue;
    for(var j=0;j<dbtbl.length;j++){
      var row = dbtbl[j];
      if(!row) continue;
      for(var col in row){
        //boolean
        if(col.endsWith('__cast_as_boolean')){
          var colbase = col.substr(0,col.length-17);
          var val = typeHandler.boolParser(row[col]);
          row[colbase] = val;
          delete row[col];
        }
      }
    }
  }
};

DBdriver.prototype.Exec = function (dbtrans, context, return_type, sql, ptypes, params, callback, dbconfig) {
  if(!dbconfig) throw new Error('dbconfig is required');
  var _this = this;
  
  _this.ExecSession(dbtrans, dbconfig, function (err, con, presql, conComplete) {
    if(dbtrans && (dbtrans.dbconfig != dbconfig)) err = new Error('Transaction cannot span multiple database connections');
    if(err) {
      if (callback != null) callback(err, null);
      else throw err;
      return;
    }
    
    var execsql = presql + _this.getContextSQL(context) + sql;
    execsql = _this.applySQLParams(execsql, ptypes, params);
    
    //_this.platform.Log(execsql);
    //console.log(params);
    //console.log(ptypes);
    
    //Execute sql
    _this.ExecQuery(con, execsql, conComplete, callback, function (rslt, notices) {
      var dbrslt = null;
      
      if (return_type == 'row') { if (rslt.length && rslt[0].length) dbrslt = rslt[0][0]; }
      else if (return_type == 'recordset'){ if(rslt.length) dbrslt = rslt[0]; }
      else if (return_type == 'multirecordset') { dbrslt = rslt; }
      else if (return_type == 'scalar') {
        if (rslt.length && rslt[0].length) {
          var row = rslt[0][0];
          for (var key in row) if (row.hasOwnProperty(key)) dbrslt = row[key];
        }
      }
      var warnings = [];
      for(var i=0;i<notices.length;i++){
        if(notices[i].severity=='WARNING'){
          warnings.push(notices[i]);
          notices.splice(i,1);
          i--;
        }
      }
      DB.util.LogDBResult(_this.platform, { sql: execsql, dbrslt: dbrslt, notices: notices, warnings: warnings });
      if (callback) callback(null, dbrslt, { notices: notices, warnings: warnings });
    });
  });
};

DBdriver.prototype.ExecTransTasks = function (execTasks, callback, dbconfig) {
  if(!dbconfig) throw new Error('dbconfig is required');
  var _this = this;
  
  _this.ExecSession(null, dbconfig, function (err, con, presql, conComplete) {
    if(err) return callback(err, null);
    //Begin transaction
    _this.ExecQuery(con, presql + "begin transaction", function () { }, callback, function () {
      var trans = new DB.TransactionConnection(con,dbconfig);
      execTasks(trans, function (dberr, rslt) {
        if (dberr != null) {
          //Rollback transaction
          _this.ExecQuery(con, "rollback transaction", conComplete, callback, function () {
            callback(dberr, null);
          });
        }
        else {
          //Commit transaction
          _this.ExecQuery(con, "commit transaction", conComplete, callback, function () {
            callback(null, rslt);
          });
        }
      });
    });
  });
};

DBdriver.prototype.escape = function(val){ return this.sql.escape(val); };

DBdriver.prototype.getContextSQL = function(context) {
  var sqlContext = (context?this.escape(context):'USystem');
  var ignoreContext = false;
  if(sqlContext=='login') ignoreContext = true;
  var rslt = "update jsharmony_meta set errcode=0,errmsg=''"+(!ignoreContext?",context='"+sqlContext+"'":"")+",jsexec='',audit_seq=null,extra_changes=0,last_insert_rowid_override=null \
                                        where (errcode<>0) or (errmsg<>'')"+(!ignoreContext?" or (context<>'"+sqlContext+"')":"")+" or (jsexec<>'') or (audit_seq is not null) or (extra_changes <> 0) or (last_insert_rowid_override is not null);";
  return rslt;
};

DBdriver.prototype.applySQLParams = function (sql, ptypes, params) {
  var _this = this;

  //Apply ptypes, params to SQL
  var ptypes_ref = {};
  if(ptypes){
    let i = 0;
    for (let p in params) {
      ptypes_ref[p] = ptypes[i];
      i++;
    }
  }
  //Sort params by length
  var param_keys = _.keys(params);
  param_keys.sort(function (a, b) { return b.length - a.length; });
  //Replace params in SQL statement
  for (let i = 0; i < param_keys.length; i++) {
    let p = param_keys[i];
    var val = params[p];
    if (val === '') val = null;
    sql = DB.util.ReplaceAll(sql, '@' + p, _this.getDBParam(ptypes ? ptypes_ref[p] : types.fromValue(val), val));
  }
  return sql;
};

exports = module.exports = DBdriver;
