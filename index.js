'use strict'

let exec = require('child_process').exec,
  spawn = require('child_process').spawn,
  mkdirp = require('mkdirp'),
  http = require('http'),
  fs = require('fs'),
  Logger;


function getFileTree(path, config) {
  let resp = {};
  let files = fs.readdirSync(path);
  for (let file of files) {
    let absPath = path + "/" + file;
    if (fs.lstatSync(absPath).isDirectory()) {
      resp[file] = {
        name: file,
        elements: getFileTree(absPath, config),
        absPath: absPath
      };
    } else {
      resp[file] = {
        name: file,
        absPath: absPath
      };
    }
  }
  return resp;
}

function getFilesList(path, config) {
  let resp = [];
  let files = fs.readdirSync(path);
  for (let file of files) {
    if (file.indexOf(config.ignore_prefix || '__') == 0) {
      continue;
    }
    let absPath = path + "/" + file;
    if (fs.lstatSync(absPath).isDirectory()) {
      let rr = getFilesList(absPath, config);
      if (!!rr) {
        for (let rFile of rr) {
          if (rFile !== '') {
            resp.push(rFile);
          }
        }
      }
    } else {
      resp.push(absPath);
    }
  }
  return resp;
}

function save(baseFolder, relPath, content, onDone) {
  let path = baseFolder + relPath;
  let filename = "index.html";
  if (path.endsWith(".html")) {
    let els = path.split("/");
    filename = els[els.length - 1];
    els.length--;
    path = els.join("/");
  }
  mkdirp(path, function(err) {
    if (err) {
      console.error("Error creating folder " + path, err);
    }
    Logger.log("info", path + " created.");
    let filepath = path + "/" + filename;
    filepath = filepath.replace("//", "/");
    fs.writeFile(filepath, content, function(err) {
      if (err) {
        return console.error("Error creating " + filepath, err);
      }
      Logger.log("info", filepath + " saved.");
      if (!!onDone) {
        onDone();
      }
    })
  });
};

function getRoutes(app) {
  let r = {};
  app._router.stack.forEach(function(el) {
    if (el.route && el.route.path) {
      var route = el.route;
      if (!r[route.path]) {
        r[route.path] = {};
      }
      for (let method in route.methods) {
        if (!r[route.path][method]) {
          r[route.path][method] = route;
        }
      }
    }
  });
  return r;
};

function makeGeneratedFiles(targetPath, basePath, app, config, onDone) {
  let staticsFolder = [basePath, config.statics].join(config.sep)
    , dataFolder = [basePath, config.database.name].join(config.sep)
    , copyStr = "cp -R " + staticsFolder + " " + targetPath
    , folderDataTarget = ([targetPath, config.apiUrl||'api'].join(config.sep)).replace(/\/\//g, '/')
    , copyData = "cp -R "+ dataFolder + " " + folderDataTarget
    ;
  copyStr = copyStr.replace(/\/\//g, '/');
  copyData = copyData.replace(/\/\//g, '/');
  Logger.log('notice', copyStr);
  Logger.log('notice', copyData);
  exec(copyStr, (err2, stdout2, stderr2) => {
    if(err2){
      Logger.log('critical', err2);
      return onDone();
    }
    let tpltsDir = [basePath, config.templates].join(config.sep);
    let fullRoutes = getFilesList(tpltsDir, config);
    let ort = getRoutes(app);
    let routes = {};
    for (let r of fullRoutes) {
      let row = {};
      routes[r.replace(tpltsDir, "")] = {
        "GET": tpltsDir
      };
    }
    var counter = {
      "started": 0,
      "finished": 0
    };
    for (let route in routes) {
      var routeData = routes[route];
      for (var method in routeData) {
        if (method.toUpperCase() !== 'GET') {
          continue;
        }
        let options = {
          host: config.host || 'localhost',
          port: config.generationPort || 6783,
          path: route
        };
        if (method.toUpperCase() !== "GET") {
          options["method"] = method.toUpperCase();
        }
        let path = route;
        let req = http.request(options, (response) => {
          let resp = '';
          response.on("data", (chunk) => {
            resp += chunk;
          });
          response.on("end", (chunk) => {
            Logger.log("info", "Saving " + path + "=>" + method);
            save(targetPath, path, resp, () => {
              counter.finished += 1;
              if (counter.started === counter.finished) {
                if (!!onDone) {
                  exec(copyData, (err3, stdout3, stderr3) => {
                    Logger.log('notice', 'data files copied.');
                    onDone();
                  });
                }
              }
            });
          });
        });
        counter.started += 1;
        req.end();
      }
    }
  });
}

function deleteFolder(targetPath, cb){
  fs.exists(targetPath, function(exists) {
      if (exists) {
        let delString = "rm -Rf " + targetPath;
        Logger.log('notice', delString);
        exec(delString, function(err, stdout, stderr){
          if(err){
            if(!!cb){
              cb(err);
            }
            return;
          }
          deleteFolder(targetPath, cb);
        });
      } else {
        Logger.log('notice', targetPath+" does not exists...");
        if(!!cb){
          cb(null);
        }
      }
  });
}

function generate(basePath, app, config, onDone) {
  let targetFolder = config.generation.targetFolder
    , targetPath = [basePath, '..', config.generation.targetFolder].join(config.sep)
    , delString = "rm -Rf " + targetPath
    ;
  if(!targetFolder || targetFolder.substring(targetFolder.length-1)==='/'){
    Logger.log('critical', "Invalid target folder, check it!.");
    onDone();
  } else {
    deleteFolder(targetPath, function(err){
      if(err){
        Logger.log('critical', err);
        return onDone();
      }
      makeGeneratedFiles(targetPath, basePath, app, config, onDone);
    });
  }
};

function generateSite() {
  let basePath = this.basePath
    , gulpargs = "es6 stylesprepro assets close".split(' ')
    , config = this.config
    , app = this.application
    ;
  let gp = spawn("gulp", gulpargs);
  gp.on('error', (err) => {
    console.log('Failed to start child process.', err);
  });
  gp.stderr.on('data', function(data){
    Logger.log('critical', data);
  });
  Logger.log('notice', 'Generating...');
  gp.on('close', function(code){
    Logger.log('notice', 'Statics generated...');
    generate(basePath, app, config, function() {
      Logger.log('success', 'Done...');
      process.exit(0);
    });
  });
}

function preExecution() {
  Logger = this.Logger;
  this.config.port = this.config.generation.port;
}

module.exports = {
  "type": "commandline",
  "commands": [
    {
      "callable": generateSite,
      "bind": true,
      "options": {
        "exit": false,
        "execute": true,
        "include": true
      },
      "value": "-g, --generate",
      "help": "Generate static site",
      "preprocessor": preExecution,
      "initial": null
    }
  ]
};
