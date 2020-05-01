/*
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

var DB = require('jsharmony-db');
var dbtypes = DB.types;
var _ = require('lodash');
var async = require('async');
var triggerFuncs = require('./DB.sqlite.triggerfuncs.js');
var path = require('path');

function DBObjectSQL(db, sql){
  this.db = db;
  this.sql = sql;
}

function getDBType(column){
  if(column.type=='varchar') return 'text';
  else if(column.type=='char') return 'text';
  else if(column.type=='binary') return 'blob';
  else if(column.type=='bigint') return 'integer';
  else if(column.type=='int') return 'integer';
  else if(column.type=='smallint') return 'integer';
  else if(column.type=='tinyint') return 'integer';
  else if(column.type=='boolean') return 'integer';
  else if(column.type=='date') return 'text';
  else if(column.type=='time') return 'text';
  else if(column.type=='datetime') return 'text';
  else if(column.type=='decimal') return 'real';
  else if(column.type=='float') return 'real';
  else if(column.type) throw new Error('Column '+column.name+' datatype not supported: '+column.type);
  else throw new Error('Column '+column.name+' missing type');
}

DBObjectSQL.prototype.getjsHarmonyFactorySchema = function(jsh){
  if(jsh&&jsh.Modules&&jsh.Modules['jsHarmonyFactory']){
    return jsh.Modules['jsHarmonyFactory'].schema||'';
  }
  return '';
}

DBObjectSQL.prototype.parseSchema = function(name){
  name = name || '';
  var rslt = {
    schema: '',
    name: name
  }
  var idx = name.indexOf('.');
  if(idx>=0){
    rslt.schema = name.substr(0,idx);
    rslt.name = name.substr(idx+1);
  }
  return rslt;
}

DBObjectSQL.prototype.init = function(jsh, module, obj){
  var sql = '';
  var caption = ['','',''];
  if(obj.caption){
    if(_.isArray(obj.caption)){
      if(obj.caption.length == 1) caption = ['', obj.caption[0].toString(), obj.caption[0].toString()];
      else if(obj.caption.length == 2) caption = ['', obj.caption[0].toString(), obj.caption[1].toString()];
      else if(obj.caption.length >= 3) caption = ['', obj.caption[1].toString(), obj.caption[2].toString()];
    }
    else caption = ['', obj.caption.toString(), obj.caption.toString()];
  }
  if(obj.type=='table'){
    sql += 'create table '+obj.name+'(\n';
    var sqlcols = [];
    var sqlforeignkeys = [];
    if(obj.columns) for(var i=0; i<obj.columns.length;i++){
      var column = obj.columns[i];
      var sqlcol = '  '+column.name;
      sqlcol += ' '+getDBType(column);
      if(column.key) sqlcol += ' primary key';
      if(column.identity) sqlcol += ' autoincrement';
      if(column.unique) sqlcol += ' unique';
      if(!column.null) sqlcol += ' not null';
      if(!(typeof column.default == 'undefined')){
        var defaultval = '';
        if(column.default===null) defaultval = 'null';
        else if(_.isString(column.default)) defaultval = "'" + this.sql.escape(column.default) + "'";
        else if(_.isNumber(column.default)) defaultval = this.sql.escape(column.default.toString());
        else if(_.isBoolean(column.default)) defaultval = (column.default?"1":"0");
        if(defaultval) sqlcol += ' default ' + defaultval;
      }      
      sqlcols.push(sqlcol);
      if(column.foreignkey){
        var foundkey = false;
        for(var tbl in column.foreignkey){
          if(foundkey) throw new Error('Table ' +obj.name + ' > Column '+column.name+' cannot have multiple foreign keys');
          var foreignkey_col = column.foreignkey[tbl];
          if(_.isString(foreignkey_col)) foreignkey_col = { column: foreignkey_col };
          var foreignkey = ' foreign key ('+column.name+') references '+tbl+'('+foreignkey_col.column+')';
          if(foreignkey_col.on_delete){
            if(foreignkey_col.on_delete=='cascade') foreignkey += ' on delete cascade';
            else if(foreignkey_col.on_delete=='null') foreignkey += ' on delete set null';
            else throw new Error('Table ' +obj.name + ' > Column '+column.name+' - column.foreignkey.on_delete action not supported.');
          }
          if(foreignkey_col.on_update){
            if(foreignkey_col.on_update=='cascade') foreignkey += ' on update cascade';
            else if(foreignkey_col.on_update=='null') foreignkey += ' on update set null';
            else throw new Error('Table ' +obj.name + ' > Column '+column.name+' - column.foreignkey.on_update action not supported.');
          }
          sqlforeignkeys.push(foreignkey);
          foundkey = true;
        }
      }
    }
    if(obj.foreignkeys){
      _.each(obj.foreignkeys, function(foreignkey){
        if(!foreignkey.columns || !foreignkey.columns.length) throw new Error('Table ' +obj.name + ' > Foreign Key missing "columns" property');
        if(!foreignkey.foreign_table) throw new Error('Table ' +obj.name + ' > Foreign Key (' + foreignkey.columns.join(',') + ') missing "foreign_table" property');
        if(!foreignkey.foreign_columns || !foreignkey.foreign_columns.length) throw new Error('Table ' +obj.name + ' > Foreign Key (' + foreignkey.columns.join(',') + ') missing "foreign_columns" property');
        var sqlforeignkey = ' foreign key (' + foreignkey.columns.join(',') + ') references ' + foreignkey.foreign_table + '(' + foreignkey.foreign_columns.join(',') + ')';
        if(foreignkey.on_delete){
          if(foreignkey.on_delete=='cascade') sqlforeignkey += ' on delete cascade';
          else if(foreignkey.on_delete=='null') sqlforeignkey += ' on delete set null';
          else throw new Error('Table ' +obj.name + ' > Foreign Key (' + foreignkey.columns.join(',') + ') - on_delete action not supported.');
        }
        if(foreignkey.on_update){
          if(foreignkey.on_update=='cascade') sqlforeignkey += ' on update cascade';
          else if(foreignkey.on_update=='null') sqlforeignkey += ' on update set null';
          else throw new Error('Table ' +obj.name + ' > Foreign Key (' + foreignkey.columns.join(',') + ') - on_update action not supported.');
        }
        sqlforeignkeys.push(sqlforeignkey);
      });
    }
    sqlcols = sqlcols.concat(sqlforeignkeys);
    sql += sqlcols.join(',\n') + '\n';
    if(obj.unique && obj.unique.length){
      for(var i=0;i<obj.unique.length;i++){
        var uniq = obj.unique[i];
        if(uniq && uniq.length){
          if(sqlcols.length) sql += '  , ';
          var cname = obj.name.replace(/\W/g, '_');
          sql += 'constraint unique_'+cname+'_'+(i+1).toString()+' unique (' + uniq.join(',') + ')\n';
        }
      }
    }
    sql += ');\n';
    if(obj.index && obj.index.length){
      for(var i=0;i<obj.index.length;i++){
        var index = obj.index[i];
        if(index && index.columns && index.columns.length){
          var idxname = obj.name.replace(/\W/g, '_');
          sql += 'create index index_'+idxname+'_'+(i+1).toString()+' on ' + obj.name + '(' + index.columns.join(',') + ');\n';
        }
      }
    }
  }
  else if(obj.type=='view'){
    sql += 'create view '+obj.name+' as select \n';
    var cols = [];
    var from = [];
    for(var tblname in obj.tables){
      var tbl = obj.tables[tblname];
      _.each(tbl.columns, function(col){
        var colname = col.name;
        if(col.sqlselect){
          cols.push('(' + DB.util.ParseMultiLine(col.sqlselect) + ') as ' + col.name);
        }
        else {
          if(colname.indexOf('.')<0) colname = tblname + '.' + colname;
          var numdots = (colname.match(/\./g) || []).length;
          if(numdots < 2) colname = '{schema}.' + colname;
          cols.push(colname);
        }
      });
      if(tbl.join_type){
        var join = '';
        if(tbl.join_type=='inner') join = 'inner join';
        else if(tbl.join_type=='left') join = 'left outer join';
        else if(tbl.join_type=='right') join = 'right outer join';
        else throw new Error('View ' +obj.name + ' > ' + tblname + ' join_type must be inner, left, or right');
        join += ' ' + tblname;
        if(tbl.join_columns){
          var join_cols = [];
          for(var joinsrc in tbl.join_columns){
            join_cols.push(joinsrc + '=' + tbl.join_columns[joinsrc]);
          }
          join += ' on ' + join_cols.join(' and ');
        }
        from.push(join);
      }
      else from.push(tblname);
    }
    sql += cols.join(',') + ' from ' + from.join(' ');
    if(obj.where) sql += ' where ' + obj.where;
    sql += ';\n';
  }
  else if(obj.type=='code'){
    var jsHarmonyFactorySchema = this.getjsHarmonyFactorySchema(jsh);
    if(jsHarmonyFactorySchema) jsHarmonyFactorySchema += '.';
    var { schema: codeschema, name: codename } = this.parseSchema(obj.name);
    if(codename.substr(0,5)=='code_') codename = codename.substr(5);
    var code_type = 'sys';
    if(obj.code_type && (obj.code_type=='app')) code_type = 'app';
    sql += "insert into "+jsHarmonyFactorySchema+jsh.map['code_'+code_type]+" (code_name, code_desc, code_schema, code_type) VALUES ('"+this.sql.escape(codename)+"', '"+this.sql.escape(caption[2])+"', '{schema}', '"+code_type+"');\n";
    sql += jsHarmonyFactorySchema+"create_code_"+code_type+"('"+this.sql.escape(codeschema)+"','"+this.sql.escape(codename)+"','"+this.sql.escape(caption[2])+"');\n";
  }
  else if(obj.type=='code2'){
    var jsHarmonyFactorySchema = this.getjsHarmonyFactorySchema(jsh);
    if(jsHarmonyFactorySchema) jsHarmonyFactorySchema += '.';
    var { schema: codeschema, name: codename } = this.parseSchema(obj.name);
    if(codename.substr(0,6)=='code2_') codename = codename.substr(6);
    var code_type = 'sys';
    if(obj.code_type && (obj.code_type=='app')) code_type = 'app';
    sql += "insert into "+jsHarmonyFactorySchema+jsh.map['code2_'+code_type]+" (code_name, code_desc, code_schema, code_type) VALUES ('"+this.sql.escape(codename)+"', '"+this.sql.escape(caption[2])+"', '{schema}', '"+code_type+"');\n";
    sql += jsHarmonyFactorySchema+"create_code2_"+code_type+"('"+this.sql.escape(codeschema)+"','"+this.sql.escape(codename)+"','"+this.sql.escape(caption[2])+"');\n";
  }

  if(obj.init && obj.init.length){
    for(var i=0;i<obj.init.length;i++){
      var row = obj.init[i];
      sql += this.getRowInsert(jsh, module, obj, row);
    }
  }

  if(sql) sql = this.db.ParseSQLFuncs(sql, this.getTriggerFuncs());
  return sql;
}

DBObjectSQL.prototype.escapeVal = function(val){
  if(val===null) return 'null';
  else if(_.isString(val)) return "'" + this.sql.escape(val) + "'";
  else if(_.isBoolean(val)) return (val?'1':'0');
  else if(val && val.sql) return val.sql;
  else return this.sql.escape(val.toString());
}

DBObjectSQL.prototype.getRowInsert = function(jsh, module, obj, row){
  var _this = this;

  row = _.extend({}, row);
  var files = [];
  if(row._FILES){
    files = row._FILES;
    delete row._FILES;
  }

  var sql = '';
  var no_file_rowid = false;
  if(_.keys(row).length==0){ no_file_rowid = true; }
  else if((_.keys(row).length==1) && ('sql' in row)){
    sql = DB.util.ParseMultiLine(row.sql).trim();
    if(sql[sql.length-1] != ';') sql = sql + ';';
    sql += '\n';
    no_file_rowid = true;
  }
  else{
    sql = 'insert into '+obj.name+'('+_.keys(row).join(',')+') select ';
    sql += _.map(_.values(row), function(val){ return _this.escapeVal(val); }).join(',');
    sql += " where not exists (select * from "+obj.name+" where ";
    var data_keys = (obj.data_keys ? obj.data_keys : _.keys(row));
    sql += _.map(data_keys, function(key){ return key+'='+_this.escapeVal(row[key]); }).join(' and ');
    sql += ");\n";
  }

  for(var file_src in files){
    var file_dst = path.join(jsh.Config.datadir,files[file_src]);
    file_src = path.join(path.dirname(obj.path),'data_files',file_src);
    file_dst = _this.sql.escape(file_dst);
    file_dst = DB.util.ReplaceAll(file_dst,'{{',"'||");
    file_dst = DB.util.ReplaceAll(file_dst,'}}',"||'");

    if(no_file_rowid){
      sql += "select '%%%copy_file:"+_this.sql.escape(file_src)+">"+file_dst+"%%%';\n";
    }
    else {
      sql += "select '%%%copy_file:"+_this.sql.escape(file_src)+">"+file_dst+"%%%' from "+obj.name+" where rowid=(select ifnull(last_insert_rowid_override,last_insert_rowid()) from jsharmony_meta);\n";
    }
  }

  if(sql){
    var objFuncs = _.extend({
      'TABLENAME': obj.name
    }, _this.getTriggerFuncs());
    sql = this.db.ParseSQLFuncs(sql, objFuncs);
  }
  return sql;
}

DBObjectSQL.prototype.getTriggerFuncs = function(){
  return _.extend({}, this.db.SQLExt.Funcs, triggerFuncs);
}

DBObjectSQL.prototype.getKeyJoin = function(obj, tbl1, tbl2, options){
  options = _.extend({ no_errors: false }, options);
  var primary_keys = [];
  var joinexp = [];
  _.each(obj.columns, function(col){
    if(col.key) joinexp.push(tbl1+"."+col.name+"="+tbl2+"."+col.name);
  });
  if(!options.no_errors && !joinexp.length) throw new Error('No primary key in table '+obj.name);
  return joinexp;
}

DBObjectSQL.prototype.resolveTrigger = function(obj, type){
  var _this = this;
  var sql = '';
  
  if(type=='insert'){
    _.each(obj.columns, function(col){
      if(col.default && col.default.sql){
        sql += "update "+obj.name+" set "+col.name+"="+col.default.sql+" where "+obj.name+"."+col.name+" is null and "+_this.getKeyJoin(obj,obj.name,'new').join(' and ');
        sql+="\\;\n";
      }
    });
  }

  if(type=='validate_update'){
    _.each(obj.columns, function(col){
      if(col.actions && _.includes(col.actions, 'prevent_update')){
        sql += "select case when (update("+col.name+")) then raise(FAIL, 'Cannot update column "+_this.sql.escape(col.name)+"') end\\;\n";
      }
    });
  }

  _.each(obj.triggers, function(trigger){
    if(_.includes(trigger.on,type)){
      if(trigger.sql) sql += trigger.sql + "\n";
      if(trigger.exec){
        var execsql = '';
        if(!_.isArray(trigger.exec)) trigger.exec = [trigger.exec];
        execsql = _.map(trigger.exec, function(tsql){
          if(_.isArray(tsql)){
            var s_tsql = '';
            for(var i=0;i<tsql.length;i++){
              var cur_tsql = tsql[i].trim();
              if(cur_tsql[cur_tsql.length-1]==';') cur_tsql = cur_tsql.substr(0, cur_tsql.length - 1) + '\\;';
              s_tsql += cur_tsql + ' ';
            }
            tsql = s_tsql;
          }
          tsql = tsql.trim();
          while(tsql[tsql.length-1]==';'){ tsql = tsql.substr(0, tsql.length-1); }
          return tsql;
        }).join('\\;\n');
        sql += execsql + "\\;\n";
      }
    }
  });
  if(sql){
    var objFuncs = _.extend({
      'TABLENAME': obj.name,
      'INSERTTABLEKEYJOIN': "rowid = new.rowid",
      'INSERTDELETEKEYJOIN': "rowid = new.rowid"
    }, _this.getTriggerFuncs());
    if((type=='insert')||(type=='validate_insert')){
      objFuncs["update"] = {
        "params": ["COL"],
        "sql": [
          "(1=1)"
        ]
      };
    }
    sql = this.db.ParseSQLFuncs(sql, objFuncs);
  }
  return sql;
}


DBObjectSQL.prototype.getTriggers = function(jsh, module, obj){
  var _this = this;
  var rslt = {};
  _.each(['validate_insert','validate_update','insert','update','delete'], function(op){
    var sql = _this.resolveTrigger(obj, op);
    if(sql) rslt[op] = sql;
  });
  return rslt;
}

DBObjectSQL.prototype.restructureInit = function(jsh, module, obj){
  var sql = '';
  var triggers = this.getTriggers(jsh, module, obj);
  //Apply trigger functions

  if(obj.type=='table'){
    if(triggers.validate_insert){
      sql += 'create trigger '+obj.name+'_before_insert before insert on '+obj.name+'\n'
      sql += 'begin\n' + triggers.validate_insert + '\nend;\n';
    }
    if(triggers.validate_update){
      sql += 'create trigger '+obj.name+'_before_update before update on '+obj.name+'\n'
      sql += 'begin\n' + triggers.validate_update + '\nend;\n';
    }
    if(triggers.insert){
      sql += 'create trigger '+obj.name+'_after_insert after insert on '+obj.name+'\n'
      sql += 'begin\n' + triggers.insert + '\nend;\n';
    }
    if(triggers.update){
      sql += 'create trigger '+obj.name+'_after_update after update on '+obj.name+'\n'
      sql += 'begin\n' + triggers.update + '\nend;\n';
    }
    if(triggers.delete){
      sql += 'create trigger '+obj.name+'_before_delete before delete on '+obj.name+'\n'
      sql += 'begin\n' + triggers.delete + '\nend;\n';
    }
  }
  else if(obj.type=='view'){
    if(triggers.insert){
      sql += 'create trigger '+obj.name+'_insert instead of insert on '+obj.name+'\n'
      sql += 'begin\n' + triggers.insert + '\nend;\n';
    }
    if(triggers.update){
      sql += 'create trigger '+obj.name+'_update instead of update on '+obj.name+'\n'
      sql += 'begin\n' + triggers.update + '\nend;\n';
    }
    if(triggers.delete){
      sql += 'create trigger '+obj.name+'_delete instead of delete on '+obj.name+'\n'
      sql += 'begin\n' + triggers.delete + '\nend;\n';
    }
  }
  return sql;
}

DBObjectSQL.prototype.restructureDrop = function(jsh, module, obj){
  var sql = '';
  var triggers = this.getTriggers(jsh, module, obj);
  _.each(['validate_insert','validate_update','insert','update','delete'], function(op){
    if(triggers[op]){
      var triggerName = '';
      if(obj.type=='table'){
        if(op=='validate_insert') triggerName = obj.name+"_before_insert";
        else if(op=='validate_update') triggerName = obj.name+"_before_update";
        else if(op=='insert') triggerName = obj.name+"_after_insert";
        else if(op=='update') triggerName = obj.name+"_after_update";
        else if(op=='delete') triggerName = obj.name+"_before_delete";
      }
      else if(obj.type=='view'){
        triggerName = obj.name+"_"+op;
      }
      sql += "drop trigger if exists "+triggerName+";\n";
    }
  });
  return sql;
}

DBObjectSQL.prototype.initData = function(jsh, module, obj){
  var sql = '';
  if(obj.init_data && obj.init_data.length){
    for(var i=0;i<obj.init_data.length;i++){
      var row = obj.init_data[i];
      sql += this.getRowInsert(jsh, module, obj, row);
    }
  }
  return sql;
}

DBObjectSQL.prototype.sampleData = function(jsh, module, obj){
  var sql = '';
  if(obj.sample_data && obj.sample_data.length){
    for(var i=0;i<obj.sample_data.length;i++){
      var row = obj.sample_data[i];
      sql += this.getRowInsert(jsh, module, obj, row);
    }
  }
  return sql;
}

DBObjectSQL.prototype.drop = function(jsh, module, obj){
  var sql = '';
  if(obj.type=='table'){
    sql += "drop table if exists "+(obj.name)+";\n";
  }
  if(obj.type=='view'){
    sql += "drop view if exists "+(obj.name)+";\n";
  }
  else if(obj.type=='code'){
    var jsHarmonyFactorySchema = this.getjsHarmonyFactorySchema(jsh);
    if(jsHarmonyFactorySchema) jsHarmonyFactorySchema += '.';
    var { schema: codeschema, name: codename } = this.parseSchema(obj.name);
    if(codename.substr(0,5)=='code_') codename = codename.substr(5);
    var code_type = 'sys';
    if(obj.code_type && (obj.code_type=='app')) code_type = 'app';
    sql += "drop table if exists "+(obj.name)+";\n";
    sql += "delete from "+jsHarmonyFactorySchema+jsh.map['code_'+code_type]+" where code_name='"+this.sql.escape(codename)+"' and code_schema='{schema}';\n";
  }
  else if(obj.type=='code2'){
    var jsHarmonyFactorySchema = this.getjsHarmonyFactorySchema(jsh);
    if(jsHarmonyFactorySchema) jsHarmonyFactorySchema += '.';
    var { schema: codeschema, name: codename } = this.parseSchema(obj.name);
    if(codename.substr(0,6)=='code2_') codename = codename.substr(6);
    var code_type = 'sys';
    if(obj.code_type && (obj.code_type=='app')) code_type = 'app';
    sql += "drop table if exists "+(obj.name)+";\n";
    sql += "delete from "+jsHarmonyFactorySchema+jsh.map['code2_'+code_type]+" where code_name='"+this.sql.escape(codename)+"' and code_schema='{schema}';\n";
  }
  return sql;
}

DBObjectSQL.prototype.initSchema = function(jsh, module){
  return '';
}

DBObjectSQL.prototype.dropSchema = function(jsh, module){
  return '';
}

exports = module.exports = DBObjectSQL;