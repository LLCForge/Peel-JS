// Makine gerçek bir döngü içeriyor (aynı durum tekrar ediyor): dokunulmamalı, davranış korunmalı
function count(n) {
  var P = 0, Q = 1;
  var i = 0;
  while (P + Q !== 0) {
    switch (P + Q) {
      case 1:
        i++;
        if (i >= n) { P = -1; }
        break;
    }
  }
  return i;
}
console.log(count(3));
// LEVEL: 3
// EXPECT: switch
