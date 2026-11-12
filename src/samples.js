'use strict';
// Short sample messages for the walkthrough and the "Open Sample" commands. All values are
// invented: the parties, identifiers, addresses and people do not exist. The samples contain no
// text from any standard; they only use the public segment layout of each format.

const EDIFACT_ORDERS = [
  "UNA:+.? '",
  "UNB+UNOC:3+5412345000176:14+5498765000134:14+240305:1015+ORD240305001'",
  "UNH+1+ORDERS:D:96A:UN:EAN008'",
  "BGM+220+PO-24-00318+9'",
  "DTM+137:20240305:102'",
  "DTM+2:20240312:102'",
  "FTX+DIN+++Deliver to gate 4 in the morning'",
  "NAD+BY+5412345000176::9'",
  "NAD+SU+5498765000134::9'",
  "CUX+2:EUR:9'",
  "LIN+1++5410000100012:EN'",
  "QTY+21:48'",
  "PRI+AAA:4.75'",
  "LIN+2++5410000100029:EN'",
  "QTY+21:12'",
  "PRI+AAA:18.90'",
  "UNS+S'",
  "MOA+86:454.80'",
  "UNT+17+1'",
  "UNZ+1+ORD240305001'"
].join('\n') + '\n';

const X12_850 = [
  'ISA*00*          *00*          *ZZ*NORTHBAYRETAIL *ZZ*HARBORSUPPLY   *240305*1015*U*00401*000000417*0*P*>~',
  'GS*PO*NORTHBAYRETAIL*HARBORSUPPLY*20240305*1015*417*X*004010~',
  'ST*850*0001~',
  'BEG*00*SA*PO-24-00318**20240305~',
  'REF*DP*017~',
  'DTM*002*20240312~',
  'N1*ST*North Bay Retail Store 17*92*ST017~',
  'N3*410 Harbour View Road~',
  'N4*Westbrook*WA*98001*US~',
  'PO1*1*48*EA*4.75**UP*541000010001~',
  'PID*F****Ceramic mug, 300 ml, white~',
  'PO1*2*12*EA*18.90**UP*541000010002~',
  'PID*F****Steel vacuum flask, 500 ml~',
  'CTT*2~',
  'SE*13*0001~',
  'GE*1*417~',
  'IEA*1*000000417~'
].join('\n') + '\n';

const HL7_ADT_A01 = [
  'MSH|^~\\&|ADMITSYS|RIVERSIDE|LABPORTAL|RIVERSIDE|20240305101500||ADT^A01^ADT_A01|RS240305-0042|P|2.5.1',
  'EVN|A01|20240305101500',
  'PID|1||RS-4471902^^^RIVERSIDE^MR||Hartwell^Mira^J||19840712|F|||18 Linden Walk^^Millford^NY^12901||555-0142^PRN^PH~555-0143^ORN^CP',
  'NK1|1|Hartwell^Tomas|SPO||555-0144^PRN^PH',
  'PV1|1|I|4E^412^B||||2201^Okafor^Lena|||SUR||||||||||||||||||||||||||||||||20240305101500',
  'AL1|1|DA|^Penicillin|MO|Rash'
].join('\r') + '\r';

const SAMPLES = Object.freeze({
  edifact: Object.freeze({ format: 'edifact', languageId: 'edifact', title: 'UN/EDIFACT purchase order (ORDERS)', text: EDIFACT_ORDERS }),
  x12: Object.freeze({ format: 'x12', languageId: 'x12', title: 'ANSI X12 purchase order (850)', text: X12_850 }),
  hl7: Object.freeze({ format: 'hl7', languageId: 'hl7', title: 'HL7 v2 admission (ADT A01)', text: HL7_ADT_A01 })
});

/** Returns the sample for a format ('edifact', 'x12' or 'hl7'), or null. */
function sampleFor(format) {
  return Object.prototype.hasOwnProperty.call(SAMPLES, format) ? SAMPLES[format] : null;
}

module.exports = { SAMPLES: SAMPLES, sampleFor: sampleFor };
