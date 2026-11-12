// js-confuser: decoder kapsam nesnesinde, this'siz çağrılıyor: (1, scope.a.d)(…)
function main(scope = { a: {} }) {
  scope.a.d = function (i, k) {
    var s = "Ifmmp!xpsme";
    return s.slice(i, i + k).split("").map(function (c) { return String.fromCharCode(c.charCodeAt(0) - 1); }).join("");
  };
  scope.a.n = function (x) { return x * 2; };
  console.log((1, scope.a.d)(0, 5) + (1, scope.a.d)(5, 6), (1, scope.a.n)(4));
}
main();
// LEVEL: 3
// EXPECT: "Hello world"
// EXPECT: (1, scope.a.n)(4)
