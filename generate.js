const fs = require('fs');
const Path = require('path');
const objdumpParser = require('arm-objdump-parser');
const fnToWrapper = require('./wrapper-generator/function-to-wrapper');

let symbolsFile = process.argv[2];
let className = process.argv[3];
let jsClassName = className;

let jsClassIx = process.argv.indexOf('--js-class-name');
if (jsClassIx !== -1) {
    jsClassName = process.argv[jsClassIx + 1];
}

let libraryName = jsClassName.toLowerCase();
let libNameIx = process.argv.indexOf('--library-name');
if (libNameIx !== -1) {
    libraryName = process.argv[libNameIx + 1];
}

let headerFile = `// @todo: add a reference to the ${className} header here`;
let headerFileIx = process.argv.indexOf('--header-file');
if (headerFileIx !== -1) {
    headerFile = '#include "' + process.argv[headerFileIx + 1] + '"';
}

let createFiles = process.argv.indexOf('--dont-create-files') === -1;

if (className === jsClassName && className.indexOf('<') > -1) {
    console.error('When passing in a generic classname, please also pass in --js-class-name');
    console.error('Usage: node generate.js symbolsfile.txt classname [--js-class-name output-classname --library-name lib-name]');
    process.exit(1);
}

if (!symbolsFile || !className) {
    console.error('Usage: node generate.js symbolsfile.txt classname [--js-class-name output-classname --library-name lib-name]');
    process.exit(1);
}

let symbols = fs.readFileSync(symbolsFile, 'utf-8');
let tree = objdumpParser(symbols);

let obj = tree.nodes.filter(c => c.tag === 'class_type' && c.name === className);
// find the one with most children...
obj.sort((a, b) => b.children.length - a.children.length);
obj = obj[0];
if (!obj) {
    console.error(`Could not find object '${className}'. Are you sure it's linked in?`);
    process.exit(1);
}

try {
    fs.mkdirSync(Path.join(__dirname, 'output'));
}
catch (ex) {}

let folder = Path.join(__dirname, 'output', libraryName + '_module');

// Now we can do interesting stuff...
let fns = obj.children.filter(c => c.tag === 'subprogram' && c.accessibility === '1\t(public)');

let mappedFns = fns.map(fn => fnToWrapper.fnToString(obj, jsClassName, fn, fns)).filter(fn => !!fn);

let members = mappedFns
    .reduce((curr, fn) => {
        curr[fn.name] = curr[fn.name] || [];
        curr[fn.name].push(fn);
        return curr;
    }, {});

let enums = mappedFns
    .reduce((curr, m) => curr.concat(m && m.enums), [])
    .reduce((curr, e) => {
        if (!e) return curr;

        curr[e.name] = e.values;
        return curr;
    }, {});

if (createFiles) {
    try {
      fs.mkdirSync(folder);
      fs.mkdirSync(Path.join(folder, 'lib'));
    } catch (e) {}

    fs.writeFileSync(Path.join(folder, 'lib', libraryName.toLowerCase() + '_module.cpp'), createCpp(libraryName, className, jsClassName, members, enums, headerFile, fns), 'utf-8');

    // Create the base files (-js.h and lib_*.h)
    fs.writeFileSync(Path.join(folder, 'lib', 'CMakeLists.txt'), createCMakeLists(jsClassName, libraryName.toLowerCase()), 'utf-8');

    fs.writeFileSync(Path.join(folder, 'modules.json'), createModulesJson(libraryName.toLowerCase(), jsClassName), 'utf-8');
    fs.writeFileSync(Path.join(folder, 'module.cmake'), createModuleCmake(libraryName.toLowerCase()), 'utf-8');

    console.log('\nDone. Created wrapper in', folder);
}
else {
    console.log('Done. Did not store the wrapper on disk.');
}

function createCMakeLists(jsClassName, libraryName) {
    return `project(${jsClassName} CXX)

file(GLOB CPP_SRC ./*.cpp)
add_library(cppmodulestatic STATIC
    \${CPP_SRC}
)

target_include_directories(cppmodulestatic PRIVATE \${JERRY_INCLUDE_DIR})
target_link_libraries(cppmodulestatic PUBLIC stdc++)

`;
}

function createCpp(libraryName, className, jsClassName, members, enums, headerFile, allFns) {
    let enumText = Object.keys(enums).map((name, ix) => {
        let values = enums[name];

        let decl = values.map(v => {
            return `jerry_set_property(enum_obj, jerry_create_string((const jerry_char_t*)"${v}"), jerry_create_number((double) ${v}));`
        }).map(v => '        ' + v).join('\n');

        let text = `
    {
        jerry_value_t enum_obj = jerry_create_object();

        jerry_value_t enum_val;
        jerry_value_t enum_key;

${decl}

        jerry_value_t global_obj = jerry_get_global_object();
        jerry_set_property(global_obj, jerry_create_string((const jerry_char_t*)"${name}"), enum_obj);
    }`;

        return text;
    }).join('\n\n');

    let body = Object.keys(members).filter(name => name !== 'ctor').map(name => {
        let fnArr = members[name];
        let argsLength = fnArr.map(f => `(args_count == ${f.argsLength})`).join(' || ');

        let fnBody = fnArr.map(fn => {
            return `${fn.body}`;
        }).join('\n');

        fnBody = fnBody.split('\n').map(l => '    ' + l).join('\n');

        return `/**
 * ${jsClassName}#${name} (native JavaScript method)
 */
jerry_value_t ${name} (const jerry_value_t function_obj, const jerry_value_t this_val, const jerry_value_t args_p[], const jerry_length_t args_count) {
${fnBody}
}`
    }).join('\n');

    let dtor = fnToWrapper.createDestructor(obj, jsClassName);
    let wrapper = fnToWrapper.createNativeWrapper(obj, jsClassName, allFns);

    let ctor = Object.keys(members).filter(name => name === 'ctor').map(name => {
        let fnArr = members[name];
        let argsLength = fnArr.map(f => `(args_count == ${f.argsLength})`).join(' || ');

        let fnBody = fnArr.map(fn => {
            return `${fn.body}`;
        }).join('\n');

        fnBody = fnBody.split('\n').map(l => '    ' + l).join('\n');

        return `/**
 * ${jsClassName} (native JavaScript constructor)
 */
jerry_value_t Construct_${jsClassName} (const jerry_value_t function_obj, const jerry_value_t this_val, const jerry_value_t args_p[], const jerry_length_t args_count) {
${fnBody}
}`
    }).join('\n');

    return `/* Generated by https://github.com/janjongboom/mbed-js-wrapper-generator */

#include "jerryscript.h"

${headerFile}

${dtor}

${body}

${wrapper}

${ctor}

extern "C" jerry_value_t Init${jsClassName}() {
${enumText}
return jerry_create_external_function(Construct_${jsClassName});
}
`;
}

function createModulesJson(libraryName, jsClassName) {
return `{
  "modules": {
    "${libraryName}": {
      "native_files": [],
      "init": "Init${jsClassName}",
      "cmakefile": "module.cmake"
    }
  }
}
`;
}

function createModuleCmake(libraryName) {
return `set(MODULE_NAME "${libraryName}")
add_subdirectory(\${MODULE_DIR}/lib/ \${MODULE_BINARY_DIR}/\${MODULE_NAME})
list(APPEND MODULE_LIBS cppmodulestatic)
`;
}
