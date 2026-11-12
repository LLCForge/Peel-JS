var __p_T1Sw_cache=Object["create"](null);var __p_UA7E_payload;function __p_Rvnr_dispatcher_0(name,flagArg,returnTypeArg,fnLengths={}){var output;var fns={"u5sdY7":function(){var[name]=__p_UA7E_payload;return"Hello, "+name+"!"},"pVqAPr":function(){var[a,b]=__p_UA7E_payload;return a+b}};if(flagArg==="MFejCDcPjp"){__p_UA7E_payload=[]}if(flagArg==="dJQTg80Xas"){function createFunction(){var fn=function(...args){__p_UA7E_payload=args;return fns[name].apply(this)};var fnLength=fnLengths[name];if(fnLength){__p_Z0oO_d_fnLength(fn,fnLength)}return fn}output=__p_T1Sw_cache[name]||(__p_T1Sw_cache[name]=createFunction())}else{output=fns[name]()}if(returnTypeArg==="lfvqYuagzN"){return{"qLeWS4uSQH":output}}else{return output}}function __p_Z0oO_d_fnLength(){}var config={["endpoint"]:"https://api.example.com/v1/collect",["retries"]:3};console["log"]((__p_UA7E_payload=["PEEL"],__p_Rvnr_dispatcher_0("u5sdY7")),config["endpoint"],(__p_UA7E_payload=[1,2],__p_Rvnr_dispatcher_0("pVqAPr")));
var greetRef = __p_Rvnr_dispatcher_0("u5sdY7", "dJQTg80Xas");
console.log(greetRef("ref"), __p_Rvnr_dispatcher_0("pVqAPr", "MFejCDcPjp"));
// js-confuser 2.x dispatcher çıktısı (E43)
// EXPECT: console.log
// GONE: _dispatcher_
// GONE: payload
