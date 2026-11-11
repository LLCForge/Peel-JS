var s = "\x48\x65\x6c\x6c\x6f";
var o = { "key": 0x1f };
console["log"](s, o["key"]);
// EXPECT: var s = "Hello";
// EXPECT: key: 31
// EXPECT: console.log(s, o.key);
// GONE: \x48
