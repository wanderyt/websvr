/*
* Description:  websvr
* Author:       Kris Zhang
* Licenses:     MIT
* Project url:  https://github.com/newghost/websvr
*/

"use strict";

//Node libraries
var fs      = require("fs");
var path    = require("path");
var qs      = require("querystring");
var os      = require("os");

var http    = require("http");
var https   = require("https");

//Open source libraries
var mime        = require("mime");
var formidable  = require("formidable");

/*
* Utility
*/
var _ = {
  //extend object to target
  extend: function(tar, obj) {
    if (!obj) return tar;

    for (var key in obj) {
      tar[key] = obj[key];
    }

    return tar;
  }
};

//Shortcuts
var define = Object.defineProperty;

//Mapping
var CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');

/*
* Define and Export WebSvr
*/
var WebSvr = module.exports = function(options) {

  var self = {};

  var SessionStore;

  /*****************Web module definitions*************/
  /*
  Configurations
  */
  var Settings = {
    //root folder of server
      root: process.cwd()

    //home folder of web
    , home: './'

    //http start
    //default port of http
    , port: 8054

    //default port of https
    , httpsPort:  8443
    , httpsKey:   ""
    , httpsCert:  ""

    //list files in directory
    , listDir: false
    //enable client-side cache(304)
    , cache: true
    //enable debug information output
    , debug: true
    //enable cache of template/include file (when enabled templates will not be refreshed before restart)
    , templateCache: true
    //show errors to user(displayed in response)
    , showError: true

    //default pages, only one is supported
    , defaultPage: "index.html"
    , 404:         ""

    /*
    Session timeout, in milliseconds.
    */
    , sessionTimeout: 1440000

    //session file stored here
    , sessionDir    : ''

    //session domain
    , sessionDomain: ''

    , sessionLength: 36

    //tempary upload file stored here
    , uploadDir:  os.tmpDir()
  };

  /*
  Logger: log sth
  */
  var Logger = (function() {
    /*
    Turn off debug when Settings.debug = false
    */
    var debug = function() {
      //diable console.log information
      if (!Settings.debug) {
        return;
      }

      var d = new Date().toISOString();
      Array.prototype.splice.call(arguments, 0, 0, d);
      console.log.apply(console, arguments);
    };

    return { debug   : debug };
  })();

  /*
  Body parser, parse the data in request body 
  when parse complete, execute the callback with response data;
  */
  var BodyParser = function(req, res, callback) {

    var receives = [];

    req.on('data', function(chunk) {
      receives.push(chunk);
    });

    req.on('end', function() {
      callback(Buffer.concat(receives).toString());
    });
  };

  /*
  Parse request with session support
  */
  var SessionParser = function() {
    var self  = this;

    //session id
    self.sid  = null;
    self.val  = null;
  };

  SessionParser.prototype = {
    init: function(req, res, cb) {
      var self   = this
        , sidKey = "_wsid"
        , sidVal
        , sidStr
        ;

      //Get or Create sid, sid exist in the cookie, read it
      var sidVal = req.cookies[sidKey];

      //Does session expired?
      var getSession = function(session) {
        var isValid = session && session.__lastAccessTime && (+new Date() - session.__lastAccessTime <= Settings.sessionTimeout);

        if (isValid) {
          self.sid = sidVal;
          self.val = session;
          self.val.__lastAccessTime = +new Date();
          cb && cb();
        } else {
          SessionStore.del(sidVal);
          setSession();
        }
      };

      var setSession = function() {
        self.create();
        res.cookie(sidKey, self.sid, { domain: Settings.sessionDomain, path: '/', httponly: true });
        cb && cb();
      };

      //Sid doesn't exist, create it
      if (!sidVal || sidVal.length != Settings.sessionLength) {
        setSession();
      } else {
        SessionStore.get(sidVal, getSession);
      }
    }

    /*
    * newId()  : [Time Stamp]-[serverID][Random Chars]     //for sessionid, fixed length
    * newID(n) : [Time Stamp][serverID][Random Chars(n)]   //for userid
    */
    , newID: function(appendLen) {
      var len = CHARS.length;
      var sid = (+new Date()).toString(len);

      if (appendLen) {
        sid += Settings.serverID || '';
        for (var i = 0; i < appendLen; i++) {
          sid += CHARS[Math.random() * len | 0];
        }
      } else {
        sid = sid + '-' + (Settings.serverID || '');
        for (var i = sid.length; i < Settings.sessionLength; i++ ) {
          sid += CHARS[Math.random() * len | 0];
        }
      }

      return sid;
    }

    //Binding new sid to this session
    , create: function() {
      var self = this;
      self.sid  = self.newID();
      self.val  = { __lastAccessTime: +new Date() };
      return self;
    }

    , update: function() {
      var self = this;
      SessionStore.set(self.sid, self.val);
    }

    //Set an key/value pair in session object
    , set: function(key, val) {
      var session = this.val;
      session.__lastAccessTime = +new Date();
      session[key] = val;
      return session;
    }

    //Get value from session file
    , get: function(key) {
      var session = this.val;
      session.__lastAccessTime = +new Date();
      return key ? session[key] : session;
    }
  };

  /*
  Parser: Functions that Filter and Handler will be called 
  */
  var Parser = function(req, res, mapper) {

    var handle = function() {
      try {
        mapper.handler(req, res);
      } catch(err) {
        var errorMsg
          = '\n'
          + 'Error ' + new Date().toISOString() + ' ' + req.url
          + '\n'
          + err.stack || err.message || 'unknow error'
          + '\n'
          ;

        console.error(errorMsg);
        Settings.showError
          ? res.end('<pre>' + errorMsg + '</pre>')
          : res.end();
      }
    };

    //add sesion support
    var parseSession = function() {
      //add sesion support
      if (mapper.session && typeof req.session == "undefined") {
        req.session = new SessionParser();
        req.session.init(req, res, handle);
      } else {
        handle();
      }
    };

    /*
    parse data in request
    */
    var parseBody = function() {
      //need to parse the request?
      if (mapper.post && typeof req.body == "undefined") {
        //Must parser the request first, or the post data will lost;
        BodyParser(req, res, function(data) {
          var body = data;

          //handle exception
          try {
            mapper.post == "json"
              && (body = JSON.parse(data || "{}"));

            mapper.post == "qs"
              && (body = qs.parse(data || ""));
          } catch(e) {
            body = {};
          }

          req.body = body;
          parseSession();
        });
      } else {
        parseSession();
      }
    };

    /*
    parse file in request, this should be at the top of the list
    */
    var parseFile = function() {
      if (mapper._before && !mapper._before(req, res)) {
        Logger.debug('"before" function does not return true, request ended.');
        res.end('This is not a valid request');
        return
      }

      //Need to parse the file in request?
      if (mapper.file && typeof req.body == "undefined") {
        //Must parser the request first, or the post data maybe lost;
        var form = new formidable.IncomingForm();

        form.uploadDir = Settings.uploadDir;

        form.parse(req, function(err, fields, files) {
          if (err) {
            Logger.debug(err);
            return;
          };

          //attach the parameters and files
          req.body  = fields;
          req.files = files;

          //in fact request will not be parsed again, because body is not undefined
          parseBody();
        });
      } else {
        parseBody();
      };
    };

    /*
    parse cookie in request
    */
    var parseCookies = function() {
      var cookie  = req.headers.cookie
        , cookies = {}
        ;

      if (cookie) {
        var cookieArr = cookie.split(';');

        for (var i = 0; i < cookieArr.length; i++) {
          var strCookie = cookieArr[i]
            , idx       = strCookie.indexOf('=')
            ;
          idx > 0 && (cookies[strCookie.substr(0, idx).trim()] = strCookie.substr(idx + 1).trim());
        }
      }

      req.cookies = cookies;
      parseFile();
    };

    parseCookies();
  };


  /*
  set: res.cookie(name, value, options)
  del: res.cookie(name, null);
  */
  var Cookie = function(name, value, options) {
    if (arguments.length < 2) {
      return Logger.debug('cookie setter ignored', name);
    }

    var self    = this
      , cookies = self.cookies = self.cookies || []
      , setStr  = name + '=' + (value || '')
      ;

    options = options || {};

    if (value === null) {
      setStr += '; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    } else if (options.expires) {
      setStr += '; expires=' + (new Date(options.expires)).toGMTString();
    }

    options.path      && (setStr += '; path=' + options.path);
    options.domain    && (setStr += '; domain=' + options.domain);
    options.secure    && (setStr += '; secure');
    options.httponly  && (setStr += '; httponly');

    cookies.push(setStr);
  };


  /*
  SessionStore Interface (MemoryStore)
  - get : (sid, callback:session)
  - set : (sid, session)
  - del : (sid)
  session object: {
    sid: {
      ....
      __lastAccessTime: dateObject
    }
  }
  */
  var MemoryStore = (function() {

    var list;

    //force update session in list, convert to big int
    //get session in list, if undefined create new one
    var get = function(sid, cb) {
      !list && init();
      !list[sid] && (list[sid] = {});
      cb && cb(list[sid]);
    };

    var set = function(sid, session) {
      !list && init();
      list[sid] = session;
    };

    //remove a sesson from list
    var del = function(sid) {
      delete list[sid];
    };

    /*
    Session clear handler
    */
    var clearHandler = function() {
      for (var sid in list) {
        var session = list[sid];
        var isValid = session.__lastAccessTime && ((new Date() - session.__lastAccessTime) || 0 <= Settings.sessionTimeout * 2);
        !isValid && del(sid);
      }
    };

    var init = function() {
      list = {};
      setInterval(clearHandler, Settings.sessionTimeout * 4);      
    };

    return {
        get     : get
      , set     : set
      , del     : del
    }

  })();

  var FileStore = (function() {

    var getPath = function(sid) {
      return path.join(Settings.sessionDir, sid);
    };

    var del = function(sid) {
      fs.unlink(getPath(sid), function(err) {
        Logger.debug("unlink session file err", err);
      });
    };

    var set = function(sid, session) {
      fs.writeFile(getPath(sid), JSON.stringify(session), function(err) {
        if (err) {
          Logger.error(err);
        }
      });
    };

    var get = function(sid, cb) {
      var session = {};
      fs.readFile(getPath(sid), function(err, data) {
        if (err) {
          Logger.debug(err);
          cb && cb(session);
          return;
        }

        try {
          session = JSON.parse(data);
        } catch (e) {
          Logger.debug(e);
        }
        cb && cb(session);
      });
    };

    /*
    Clear the sessions, you should do it manually somewhere, etc:
    setInterval(websvr.SessionStore.clear, 200 * 60 * 1000)
    */
    var clear = function() {
      fs.readdir(Settings.sessionDir, function(err, files) {
        if (err) return Logger.debug(err);

        //Delete these sessions that created very very long ago
        var expire = +new Date() - Settings.sessionTimeout * 24;

        for (var i = 0; i < files.length; i++) {
          var file  = files[i]
            , idx   = file.indexOf('-')
            ;

          if (file.length == Settings.sessionLength && idx > 0) {
            var stamp = parseInt(file.substr(0, idx), CHARS.length);
            //remove the expired session
            stamp && stamp < expire && del(file);
          }
        }
      });
    };

    return {
        get   : get
      , set   : set
      , del   : del
      , clear : clear
    }

  })();

  /*
  Mapper: Used for Filter & Handler,
  expression: required parameter
  handler:    required parameter
  options:    optional parameters
  */
  var Mapper = function(expression, handler, options) {
    var self = this;

    self.expression = expression;
    self.handler = handler;

    typeof options == 'object'
      ? self.extend(options)
      : (self.post = options);
  };

  Mapper.prototype = {
    /*
    Does this mapper matched this request?
    Filter and Handler doesn't have the same matched rules when you passing a string
    Filter  : Match any section of the request url,          e.g., websvr.filter(".svr", cb);
    Handler : Match from the begining but it can bypass '/', e.g., websvr.handle("home/login", cb) or websvr.handle("/home/login")
    */
    match: function(req, isHandler) {
      var self        = this
        , reqUrl      = req.url
        , expression  = self.expression
        ;

      //No expression? It's a general filter mapper
      if (!expression) return true;

      switch (expression.constructor) {
        //String handler must start with home path, but it can bypass '/'
        case String:
          return self.matchString(req, isHandler, expression);
        case RegExp: return expression.test(reqUrl);
        case Array:
          for (var i = 0, l = expression.length; i < l; i++) {
            if (self.matchString(req, isHandler, expression[i])) {
              return true;
            }
          }
          return false;
      }

      return false;
    },

    /*
    Handle string expression like: /login/:username  or /userinfo/
    */
    matchString: function(req, isHandler, expression) {
      var reqUrl = req.url;

      //Pure string without params
      if (expression.indexOf('/:') < 0) {
        var idx = reqUrl.indexOf(expression);

        /*
        fix: url(['/m'], cb) & url(['/more'], cb) will match the same handler
        */
        if (isHandler) {
          if ((idx == 0 || idx == 1)) {
            var lastChar = reqUrl.charAt(idx + expression.length)
            return lastChar == '' || lastChar == '/' || lastChar == '?'
          }
        } else {
          return idx > -1;
        }

        return false;
      //Handle and pickup params
      } else {
        var params = this.parseUrl(expression, reqUrl);
        params && _.extend(req.params, params);
        return params;
      }
    },

    /*
    * Pickup the params in the request url
    * expression = /home/:key/:pager
    *   /home/JavaScript => { id: 'JavaScript', pager: '' }
    *   /key/JavaScript  => false 
    */
    parseUrl: function(expression, reqUrl) {
      //Remove the params in querystring
      var idx = reqUrl.indexOf('?');
      idx > 0 && (reqUrl = reqUrl.substr(0, idx));

      var parts   = expression.split('/')
        , start   = expression.charAt(0) === '/' ? 0 : 1
        , urls    = reqUrl.split('/')
        , params  = {}
        ;

      for (var i = 0, l = parts.length; i < l; i++) {
        var part  = parts[i]
          , param = urls[i + start]
          ;

        if (part.charAt(0) === ':') {
          var paramName = part.substr(1);
          try {
            params[paramName] = decodeURIComponent(param || '');
          } catch(err) {
            params[paramName] = param;
          }
        } else if (part != param) {
          return false;
        }
      }

      return params;
    },

    /*
    Add optional parameters on current mapper
    i.e:
    session:  boolean
    file:     boolean
    parse:    boolean
    */ 
    extend: function(options) {
      for(var key in options) {
        this[key] = options[key]
      }
    },

    /*
    Something need to be done first: i.e:
    check the file size and extension before uploading files;
    check the content-length before receiving a post json
    */
    before: function(func) {
      func && (this._before = func)
    }
  };

  /*
  Http Filter: Execute all the rules that matched,
  Filter will be always called before a handler. 
  */
  var Filter = {
    //filter list
    filters: []
    
    /*
    filter: add a new filter
    expression: string/regexp [optional]
    handler:    function      [required]
    options:    object        [optional]
    */
    , filter: function(expression, handler, options) {
      //The first parameter is Function => (handler, options)
      if (expression.constructor == Function) {
        options = handler;
        handler = expression;
        expression = null;
      }

      var mapper = new Mapper(expression, handler, options);
      Filter.filters.push(mapper);

      return mapper;
    }

    //Session: parse the session
    , session: function(expression, handler, options) {
      var mapper = this.filter(expression, handler, options);
      mapper.session = true;
      return mapper;
    }

    /*
    file receiver: it's a specfic filter,
    this filter should be always at the top of the filter list
    */
    , file: function(expression, handler, options) {
      var mapper = new Mapper(expression, handler, options);
      mapper.file = true;
      //insert at the top of the filter list
      Filter.filters.splice(0, 0, mapper);

      return mapper;
    }
  };

  /*
  Filter Chain
  */
  var FilterChain = function(cb, req, res) {
    var self = this;

    self.idx = 0;
    self.cb = cb;

    self.req = req;
    self.res = res;
  };

  FilterChain.prototype = {
    next: function() {
      var self = this
        , req  = self.req
        , res  = self.res
        ;

      var mapper = Filter.filters[self.idx++];

      //filter is complete, execute callback;
      if (!mapper) return self.cb && self.cb();

      /*
      If not Matched go to next filter
      If matched need to execute the req.next() in callback handler,
      e.g:
      webSvr.filter(/expression/, function(req, res) {
        //filter actions
        req.next(req, res);
      }, options);
      */
      if (mapper.match(req)) {
        Logger.debug("filter matched", self.idx, mapper.expression, req.url);

        //filter matched, parse the request and then execute it
        Parser(req, res, mapper);
      } else {
        //filter not matched, validate next filter
        self.next();
      }
    }
  };

  /*
  Http Handler: Execute and returned when when first matched;
  At the same time only one Handler will be called;
  */
  var Handler = {
    handlers: []
    /*
    url: add a new handler
    expression: string/regexp [required]
    handler:    [many types]  [required]
    options:    object        [optional]
    */
    , url: function(expression, handler, options) {
      if (!expression) {
        Logger.log('url expression ignored');
      } else {
        var mapper = new Mapper(expression, handler, options);
        Handler.handlers.push(mapper);
      }
      return self;
    }

    , post: function(expression, handler, options) {
      if (expression && handler) {
        return this.url(expression, handler, options || 'qs');
      }
      return self;
    }

    , handle: function(req, res) {
      //flag: is matched?
      for(var i = 0, len = Handler.handlers.length; i < len ; i++) {

        var mapper = Handler.handlers[i];
        //This is handler match
        if (mapper.match(req, true)) {

          Logger.debug("handler matched", i, mapper.expression, req.url);

          var handler = mapper.handler,
              type    = handler.constructor.name;

          switch(type) {
            //function: treated it as custom function handler
            case "Function":
              Parser(req, res, mapper);
              break;

            //string: treated it as content
            case "String":
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(handler);
              break;

            //array: treated it as a file.
            case "Array":
              res.sendFile(handler[0]);
              break;
          }
          return true;
        }
      }

      return false;

    }   //end of handle
  };

  /*
  ListDir: List all the files in a directory
  */
  var ListDir = (function() {

    var urlFormat = function(url) {
      url = url.replace(/\\/g,'/');
      url = url.replace(/ /g,'%20');
      return url;
    };

    //Align to right
    var date = function(date) {
      var d = date.getFullYear() 
        + '-' + (date.getMonth() + 1)
        + '-' + (date.getDay() + 1)
        + " " + date.toLocaleTimeString();
      return "                ".substring(0, 20 - d.length) + d;
    };

    //Align to left
    var size = function(num) {
      return num + "                ".substring(0, 12 - String(num).length);
    };

    //Create an anchor
    var anchor = function(txt, url) {
      url = url ? url : "/";
      return '<a href="' + url + '">' + txt + "</a>";
    };

    var listDir = {
      //List all the files in a directory
      list: function(req, res, dir) {
        var url = req.url,
            cur = 0,
            len = 0;

        var listBegin = function() {
          res.writeHead(200, {"Content-Type": "text/html"});
          res.write("<h2>http://" + req.headers.host + url + "</h2><hr/>");
          res.write("<pre>");
          res.write(anchor("[To Parent Directory]", url.substr(0, url.lastIndexOf('/'))) + "\r\n\r\n");
        };

        var listEnd = function() {
          res.write("</pre><hr/>");
          res.end("<h5>Count: " + len + "</h5>");
        };

        listBegin();

        fs.readdir(dir, function(err, files) {
          if (err) {
            listEnd();
            Logger.debug(err);
            return;
          }

          len = files.length;

          for(var idx = 0; idx < len; idx++) {
            //Persistent the idx before make the sync process
            (function(idx) {
              var filePath = path.join(dir, files[idx]),
                  fileUrl = urlFormat(path.join(url, files[idx]));

              fs.stat(filePath, function(err, stat) {
                cur++;

                if (err) {
                  Logger.debug(err);
                }else{
                  res.write(
                    date(stat.mtime)
                    + "\t" + size(stat.size)
                    + anchor(files[idx], fileUrl)
                    + "\r\n"
                  );
                }

                (cur == len) && listEnd();
              });
            })(idx);
          }

          (len == 0) && listEnd();
        });
      }
    };

    return listDir;
  }());

  /*
  * Template Engine
  */
  var Template = (function() {

    //Caching of template files.
    var templatePool    = {}
      , includeRegExp   = /<!--#include="[\w\.\\\/]+"-->/g
      , includeBeginLen = 14
      , includeAfterLen = 4
      ;

    //default engine and defaultModel (e.g., define global footer/header in model)
    var engineFunc    = require("dot").compile
      , defaultModel  = null
      ;

    //get a file
    var getFile = function(filename, cb) {
      //if template cache enabled, get from cache pool directly
      if (Settings.templateCache && templatePool[filename]) {
        cb && cb(templatePool[filename]);
      } else {
        /*
        * webSvr.render('/home.tmpl', model)  : means related to Setting.root
        * webSvr.render('home.tmpl', model)   : means related to Setting.home
        */
        var firstChar = filename && filename.charAt(0)
          , fullpath  = path.join(firstChar == '/' ? Settings.root : Settings.home, filename)
          ;

        fs.readFile(fullpath, function(err, tmpl) {
          if (err) {
            Logger.debug(err);
            cb && cb("");
          } else {
            tmpl = tmpl.toString();
            templatePool[filename] = tmpl;
            Logger.debug('update template cache', filename);
            cb && cb(tmpl);
          }
        });
      }
    };

    var getTemplate = function(filename, cb) {
      getFile(filename, function(tmpl) {
        /*
        find and update all the include files,
        will get templates from cache for making the process easier,
        the first refresh will not work, need some time to update the cache pool
        */
        tmpl = tmpl.replace(includeRegExp, function(fileStr) {
          Logger.debug('Include File:', fileStr);
          var includeFile = fileStr.substring(includeBeginLen, fileStr.length - includeAfterLen);
          getFile(includeFile);
          return templatePool[includeFile] || '';
        });

        cb(tmpl);
      });
    };

    //render a file
    var render = function(chrunk, model, outFn) {
      var params
        , tmplFn;

      if (defaultModel) {
        params = Object.create(defaultModel);
        _.extend(params, model);
      } else {
        params = model;
      }

      try {
        tmplFn = engineFunc(chrunk);
        outFn(tmplFn(params));
      } catch(err) {
        Logger.debug(err);
        outFn(JSON.stringify(err));
      }
    };

    return {
        //render templates
        render: function(tmplUrl, model, outFn) {
          var res = this
            , end = outFn || res.end
            , len = arguments.length
            ;

          len < 1 && (tmplUrl = {});

          if (len < 2) {
            if (typeof tmplUrl == 'object') {
              model   = tmplUrl;
              /*
              * remove the first '/' make it as related path
              */
              tmplUrl = res.req.url.substr(1);

              var idx = tmplUrl.indexOf('?');
              idx > -1 && (tmplUrl = tmplUrl.substr(0, idx));              
            } else {
              model   = {};
            }
          }

          getTemplate(tmplUrl, function(tmpl) {
            render(tmpl, model, end);
          });
        }
      , engine: function(_engineFunc) {
          engineFunc = _engineFunc;
        }
      , model: function(_model) {
          defaultModel = _model;
        }
      , clear: function() {
          for (var tmpl in templatePool) {
            delete templatePool[tmpl]
          }
        }
    }
  }());


  /*****************Web initial codes*************/
  var fileHandler = function(req, res) {

    var url       = req.url
      , hasQuery  = url.indexOf("?")
      ;

    //fs.stat can't recognize the file name with querystring;
    url = hasQuery > 0 ? url.substring(0, hasQuery) : url;

    var fullPath = path.join(Settings.home, url);

    //Handle path
    var handlePath = function(phyPath) {
      fs.stat(phyPath, function(err, stat) {

        //Consider as file not found
        if (err) return self.write404(res);

        //Is file? Open this file and send to client.
        if (stat.isFile()) {
          // "If-modified-since" undefined, mark it as 1970-01-01 0:0:0
          var cacheTime = new Date(req.headers["if-modified-since"] || 1);

          // The file is modified
          if (Settings.cache && stat.mtime <= cacheTime) {
            res.writeHead(304);
            res.end();

          // Else send "not modifed"
          } else {
            res.setHeader("Last-Modified", stat.mtime.toUTCString());
            writeFile(res, phyPath);
          }
        }

        //Is Directory?
        else if (stat.isDirectory()) {
          handleDefault(phyPath);
        }

        //Or write the 404 pages
        else {
          self.write404(res);
        }

      });
    };

    //List all the files and folders.
    var handleDir = function(dirPath) {
      Settings.listDir
        ? ListDir.list(req, res, dirPath)
        : self.write403(res);
    };

    //Handle default page
    var handleDefault = function(dirPath) {
      var defaultPage = Settings.defaultPage;

      if (defaultPage) {
        var defaultPath = path.join(dirPath, defaultPage);

        fs.exists(defaultPath, function(exists) {
          //If page exists hanle it again
          if (exists) {
            //In order to make it as a dir path for loading static resources
            if (url[url.length - 1] != '/') {
              return res.redirect(url + '/');
            }

            handlePath(defaultPath);
          //If page doesn't exist hanlde the dir again
          } else {
            handleDir(dirPath);
          }
        });
      } else {
        handleDir(dirPath);
      }
    };

    handlePath(fullPath);
  };

  var requestHandler = function(req, res) {
    //Make request accessible in response object
    res.req = req;

    //Response may be shutdown when do the filter, in order not to cause exception,
    //Rewrite the write/writeHead functionalities of current response object
    var endFn = res.end;
    res.end = function() {

      //If Content-Type is undefined, using text/html as default
      if (!res.headersSent) {
        !res.getHeader('Content-Type')    && res.setHeader('Content-Type', 'text/html; charset=' + (res.charset || 'utf-8'));
        res.cookies && res.cookies.length && res.setHeader('Set-Cookie', res.cookies);
      }

      //Execute old end
      endFn.apply(res, arguments);
      //Rewirte write/writeHead on response object
      res.write = res.writeHead = res.setHeader = function() {
        Logger.debug("response is already end, response.write ignored!")
      };

      //Update session when resonse.end is executed
      req.session && req.session.update();
    };

    res.sendRootFile = function(filePath) {
      writeFile(res, path.join(Settings.root, filePath));
    };

    res.sendHomeFile = res.sendFile = function(filePath) {
      writeFile(res, path.join(Settings.home, filePath));
    };

    //301/302 : move permanently
    res.redirect = function(url, status) {
      res.statusCode = status || 302;
      res.setHeader('Location', url);
      res.end();
    };

    //set content-type
    res.type = function(type) {
      if(type && !res.headersSent) {
        res.getHeader('Content-Type') && res.removeHeader("Content-Type");
        res.setHeader('Content-Type', (mime.lookup(type) || 'text/plain') + '; charset=' + (res.charset || 'utf-8'));
      }
    };

    //Send sth
    res.send = function(type, content) {
      if (arguments.length < 2) {
        content = type;
        type    = null;
      }

      if (typeof content == 'object') {
        content = JSON.stringify(content);
        type = type || 'json';
      }

      if (type) {
        typeof type == 'number'
          ? res.writeHead(type)
          : res.type(type);
      }
      res.end(content || '');
    };

    res.cookie = Cookie;

    //render template objects
    res.render = Template.render;

    //params in the matched url
    req.params = {};

    //initial httprequest
    var filterChain = new FilterChain(function() {

      //if handler not match, send the request
      !Handler.handle(req, res) && fileHandler(req, res);

    }, req, res);

    //Hook FilterChain object on the request
    req.filter = filterChain;

    //Handle the first filter
    req.filter.next();
  };

  var writeFile = function(res, fullPath) {
    fs.readFile(fullPath, function(err, data) {
      if (err) {
        Logger.debug(err);
        return;
      }

      res.type(fullPath);
      res.writeHead(200);
      res.end(data, "binary");
    });
  };

  //API have function chain
  //Mapper
  self.parseUrl = Mapper.prototype.parseUrl;

  //Server ID
  self.newID    = SessionParser.prototype.newID;

  //Filter
  self.use      = Filter.filter;
  self.filter   = Filter.filter;
  self.session  = Filter.session;
  self.file     = Filter.file;

  //Handler
  self.get      = Handler.url;
  self.url      = Handler.url;
  self.handle   = Handler.url;
  self.handler  = Handler.url;
  self.post     = Handler.post;
  self.settings = Settings;

  //Template
  self.render   = Template.render;
  self.engine   = Template.engine;
  self.model    = Template.model;
  self.clear    = Template.clear;

  //Get a full path of a request
  self.getFullPath = function(filePath) {
    return path.join(Settings.home, filePath);
  };

  self.write403 = function(res) {
    res.writeHead(403, {"Content-Type": "text/html"});
    res.end("Access forbidden!");

    return self;
  };

  self.write404 = function(res) {
    var tmpl404 = Settings["404"];

    res.writeHead(404, {"Content-Type": "text/html"});

    tmpl404
      ? res.render(tmpl404, null)
      : res.end("File not found!");

    return self;
  };

  self.running = false;

  //start http server
  self.start = function() {

    if (self.running) {
      console.log('Already running, ignored');
      return self;
    }

    //Create http server: Enable by default
    if (Settings.port) {
      var port = Settings.port;

      var httpSvr = self.httpSvr || http.createServer(requestHandler);
      httpSvr.listen(port);

      console.log("Http server running at"
        ,"home:", Settings.home
        ,"port:", port
      );

      self.httpSvr = httpSvr;
    }

    //Create https server: Disable by default
    if ( Settings.httpsPort
      && Settings.httpsKey
      && Settings.httpsCert) {

      var httpsPort = Settings.httpsPort;

      var httpsSvr = self.httpsSvr || https.createServer({
        key:  Settings.httpsKey,
        cert: Settings.httpsCert
      }, requestHandler);

      httpsSvr.listen(httpsPort);

      console.log("Https server running at"
        ,"home:", Settings.home
        ,"port:", httpsPort
      );

      self.httpsSvr = httpsSvr;
    }

    self.running = true;

    return self;
  };

  //stop http server
  self.stop = function() {
    self.httpSvr  && self.httpSvr.close();
    self.httpsSvr && self.httpsSvr.close();
    self.running = false;

    return self;
  };

  //init
  self.init = function() {
    //Update the default value of Settings
    _.extend(Settings, options);

    SessionStore = Settings.sessionDir ? FileStore : MemoryStore;

    //Start by default
    self.start();

    return self;
  };

  //property: filters & handlers
  define(self, 'filters', {
    get: function() { 
      return Filter.filters
    },
    set: function(filters) {
      Filter.filters = filters;
    }
  });

  define(self, 'handlers', {
    get: function() {
      return Handler.handlers;
    },
    set: function(handlers) {
      Handler.handlers = handlers;
    }
  });

  define(self, 'sessionStore', {
    get: function() {
      return SessionStore;
    },
    set: function(sessionStore) {
      if (sessionStore && sessionStore.get && sessionStore.set && sessionStore.del) {
        SessionStore = sessionStore;
      } else {
        Logger.debug('Your session storage do not have interface: get/set/del');
      }
    }
  });

  //init
  self.init();

  return self;

};