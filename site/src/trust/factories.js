// The Pons factories that emit TokenLaunched (lowercase). The same list as api/src/env.js FACTORIES (a test
// checks they agree): the browser reads a coin the launch index doesn't have yet straight from the chain, and
// only a launch from one of these counts.
export const FACTORY_ADDRESSES = [
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',   // Pons V2
  '0x7e1eabd52ae29598e6483f72dcf1a70b14284db8',   // Pons early
  '0x99abe567f756fc33fff352501042e51772def04b',   // Pons test 1
  '0xa7531a9d5f183bb199a1553ef9234273918306b7',   // Pons test 2
  '0xb2efb7078bc184a8a44ab881855ca3174396920a',   // Pons test 3
  '0xf839f09fda50c9c3fe4ef4869a5a7e312b5333ab',   // Pons test 4
  '0x408f3c58e9de4dcf579b8ad3b3aa4b6880d3f99b',   // Pons test 5
  '0x537a43002af36f14982a00a1d8749933130ae128',   // Pons test 6
];

// No factory launched anything below this block (api/src/env.js INDEX_FLOOR).
export const INDEX_FLOOR = 20000000;
