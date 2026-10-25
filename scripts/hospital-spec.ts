// The synthetic hospital ("Riverside General", fictional) that Lotline is demonstrated on.
// Products and NDCs are real (from the openFDA snapshot); locations, lots, quantities,
// dispensing and purchase orders are invented. Lots are designed around six real, ongoing
// FDA recalls so each scenario has an exact answer, and the decoys are the mistakes a
// careless agent (or a tired human) would make.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { toNdc11 } from "../src/ndc.ts";

export const DEMO_DATE = "2026-10-24"; // the hospital's "today", fixed for reproducible runs

export const LOCATIONS = [
  { location_code: "MAIN", name: "Central Pharmacy", kind: "pharmacy" },
  { location_code: "OR", name: "Operating Room Satellite Pharmacy", kind: "satellite" },
  { location_code: "LD", name: "Labor and Delivery Dispensing Cabinet", kind: "cabinet" },
  { location_code: "ED", name: "Emergency Department Dispensing Cabinet", kind: "cabinet" },
  { location_code: "ED-CART", name: "Emergency Department Crash Carts", kind: "crash_cart" },
  { location_code: "ICU", name: "Intensive Care Unit Dispensing Cabinet", kind: "cabinet" },
  { location_code: "TPN", name: "Central Pharmacy Sterile Compounding (TPN)", kind: "compounding" },
];

type Pkg = { package_ndc: string; labeler_name: string; brand_name: string | null; generic_name: string; active_ingredients: string; dosage_form: string; route: string; package_description: string };
const packages: Pkg[] = readFileSync(path.join(ROOT, "data/snapshot/fda_ndc_packages.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const byNdc = new Map(packages.map(p => [p.package_ndc, p]));

function pkg(ndc: string): Pkg {
  const p = byNdc.get(ndc);
  if (!p) throw new Error(`NDC ${ndc} is not in the openFDA snapshot; re-run data:fetch or fix the spec`);
  return p;
}

// One row per stocked product. `ndc` is FDA's hyphenated package NDC; the hospital stores ndc11.
type ItemSpec = { item_id: string; ndc: string; description: string; strength: string; unit: string; units_per_pack: number; daily_use: number; formulary: "formulary" | "restricted" | "non-formulary" };

export const ITEM_SPECS: ItemSpec[] = [
  // --- Anchors: the six recalled products ---
  { item_id: "RX-ROPI-05-20", ndc: "63323-286-23", description: "ROPIVACAINE 0.5% 20ML SDV NAROPIN", strength: "5 mg/mL", unit: "vial", units_per_pack: 25, daily_use: 9, formulary: "formulary" },
  { item_id: "RX-DEX-70-2000", ndc: "0338-0719-06", description: "DEXTROSE 70% 2000ML BAG", strength: "70 g/100 mL", unit: "bag", units_per_pack: 1, daily_use: 1.2, formulary: "formulary" },
  { item_id: "RX-CLIN-900-50", ndc: "0338-3814-24", description: "CLINDAMYCIN 900MG/50ML D5W GALAXY", strength: "900 mg/50 mL", unit: "bag", units_per_pack: 24, daily_use: 6, formulary: "formulary" },
  { item_id: "RX-FURO-80-TAB", ndc: "69315-118-01", description: "FUROSEMIDE 80MG TAB 100CT", strength: "80 mg", unit: "tablet", units_per_pack: 100, daily_use: 38, formulary: "formulary" },
  { item_id: "RX-BICARB-84-50", ndc: "0409-6637-14", description: "SODIUM BICARB 8.4% 50MEQ/50ML LIFESHIELD SYR", strength: "1 mEq/mL", unit: "syringe", units_per_pack: 10, daily_use: 2.5, formulary: "formulary" },
  { item_id: "RX-KETO-60-2", ndc: "31722-307-25", description: "KETOROLAC 60MG/2ML SDV IM", strength: "60 mg/2 mL", unit: "vial", units_per_pack: 25, daily_use: 5, formulary: "formulary" },
  // --- Decoys: same molecule or brand, not covered by the anchor recalls ---
  { item_id: "RX-ROPI-02-100", ndc: "63323-285-65", description: "ROPIVACAINE 0.2% 100ML BTL NAROPIN", strength: "2 mg/mL", unit: "bottle", units_per_pack: 12, daily_use: 4, formulary: "formulary" },
  { item_id: "RX-ROPI-05-30", ndc: "63323-286-35", description: "ROPIVACAINE 0.5% 30ML SDV NAROPIN", strength: "5 mg/mL", unit: "vial", units_per_pack: 25, daily_use: 2, formulary: "formulary" },
  // --- Alternatives already on the shelf ---
  { item_id: "RX-ROPI-05-20-SOM", ndc: "70069-063-25", description: "ROPIVACAINE 0.5% 20ML SDV (SOMERSET)", strength: "5 mg/mL", unit: "vial", units_per_pack: 25, daily_use: 0, formulary: "formulary" },
  { item_id: "RX-BICARB-84-50-FK", ndc: "63323-089-50", description: "SODIUM BICARB 8.4% 50ML SDV (FRESENIUS)", strength: "1 mEq/mL", unit: "vial", units_per_pack: 25, daily_use: 0.5, formulary: "formulary" },
];

type LotSpec = { item_id: string; location_code: string; lot_number: string; expiry_date: string; qty_units: number; received_on: string; po_number: string | null; note: string };

// `note` documents the intended answer for each lot. It is stripped before data reaches agents.
export const LOT_SPECS: LotSpec[] = [
  // Naropin 0.5% 20 mL, recall D-0727-2026: "Lot #: 6133436, Exp. Date 10/2028"
  { item_id: "RX-ROPI-05-20", location_code: "OR", lot_number: "6133436", expiry_date: "2028-10-31", qty_units: 50, received_on: "2026-06-18", po_number: "PO-26-0611", note: "AFFECTED: lot and expiry match" },
  { item_id: "RX-ROPI-05-20", location_code: "LD", lot_number: "6133436", expiry_date: "2028-10-31", qty_units: 12, received_on: "2026-06-18", po_number: "PO-26-0611", note: "AFFECTED: lot and expiry match" },
  { item_id: "RX-ROPI-05-20", location_code: "MAIN", lot_number: "6133437", expiry_date: "2028-10-31", qty_units: 75, received_on: "2026-08-02", po_number: "PO-26-0790", note: "NOT AFFECTED: adjacent lot number (near miss)" },
  { item_id: "RX-ROPI-05-20", location_code: "ICU", lot_number: "6133436", expiry_date: "2027-10-31", qty_units: 6, received_on: "2026-06-18", po_number: "PO-26-0611", note: "REVIEW: lot matches but recorded expiry does not; likely data-entry error, quarantine pending check" },
  { item_id: "RX-ROPI-02-100", location_code: "LD", lot_number: "6133436", expiry_date: "2028-10-31", qty_units: 24, received_on: "2026-06-18", po_number: "PO-26-0611", note: "NOT AFFECTED: same lot string on a different strength; recall covers 0.5% 20 mL only" },
  { item_id: "RX-ROPI-02-100", location_code: "OR", lot_number: "6140215", expiry_date: "2028-12-31", qty_units: 36, received_on: "2026-09-10", po_number: "PO-26-0902", note: "NOT AFFECTED: openfda lists this NDC but the recall text does not" },
  { item_id: "RX-ROPI-05-30", location_code: "OR", lot_number: "6129980", expiry_date: "2028-07-31", qty_units: 25, received_on: "2026-05-20", po_number: "PO-26-0507", note: "NOT AFFECTED: 30 mL presentation" },
  { item_id: "RX-ROPI-05-20-SOM", location_code: "MAIN", lot_number: "SR25K118", expiry_date: "2027-11-30", qty_units: 20, received_on: "2026-09-29", po_number: "PO-26-0951", note: "ALTERNATIVE on hand" },
  // Dextrose 70% 2000 mL, recall D-0850-2026 (Class I): "Lot #: Y495066, Exp. Date July 31, 2027"
  { item_id: "RX-DEX-70-2000", location_code: "TPN", lot_number: "Y495066", expiry_date: "2027-07-31", qty_units: 8, received_on: "2026-08-21", po_number: "PO-26-0833", note: "AFFECTED: Class I" },
  { item_id: "RX-DEX-70-2000", location_code: "TPN", lot_number: "Y501122", expiry_date: "2027-09-30", qty_units: 4, received_on: "2026-10-03", po_number: "PO-26-0960", note: "NOT AFFECTED" },
  // Clindamycin 900 mg/50 mL, recall D-0815-2026: lots NC185424 (2/12/2027), NC185479 (2/13/2027), NC193948 (10/23/2027)
  { item_id: "RX-CLIN-900-50", location_code: "ICU", lot_number: "NC185479", expiry_date: "2027-02-13", qty_units: 18, received_on: "2026-07-14", po_number: "PO-26-0704", note: "AFFECTED" },
  { item_id: "RX-CLIN-900-50", location_code: "ED", lot_number: "NC193948", expiry_date: "2027-10-23", qty_units: 10, received_on: "2026-08-30", po_number: "PO-26-0851", note: "AFFECTED" },
  { item_id: "RX-CLIN-900-50", location_code: "MAIN", lot_number: "NC185480", expiry_date: "2027-02-14", qty_units: 40, received_on: "2026-07-14", po_number: "PO-26-0704", note: "NOT AFFECTED: adjacent lot number" },
  // Furosemide 80 mg, recall D-0486-2026: "Lots# H03125, H03225, H03325, Exp Date: 2027/08"
  { item_id: "RX-FURO-80-TAB", location_code: "MAIN", lot_number: "H03225", expiry_date: "2027-08-31", qty_units: 600, received_on: "2026-03-30", po_number: "PO-26-0322", note: "AFFECTED" },
  { item_id: "RX-FURO-80-TAB", location_code: "ICU", lot_number: "H03225", expiry_date: "2027-08-31", qty_units: 90, received_on: "2026-03-30", po_number: "PO-26-0322", note: "AFFECTED" },
  { item_id: "RX-FURO-80-TAB", location_code: "ED", lot_number: "H03425", expiry_date: "2027-09-30", qty_units: 120, received_on: "2026-06-11", po_number: "PO-26-0599", note: "NOT AFFECTED" },
  // Sodium bicarbonate 8.4% syringe, recall D-0591-2025: "Lot #: LH2671, Exp. 11/30/2026"
  { item_id: "RX-BICARB-84-50", location_code: "ED-CART", lot_number: "LH2671", expiry_date: "2026-11-30", qty_units: 20, received_on: "2025-07-02", po_number: "PO-25-0640", note: "AFFECTED: emergency drug in crash carts" },
  { item_id: "RX-BICARB-84-50", location_code: "ICU", lot_number: "LH2671", expiry_date: "2026-11-30", qty_units: 10, received_on: "2025-07-02", po_number: "PO-25-0640", note: "AFFECTED" },
  { item_id: "RX-BICARB-84-50", location_code: "MAIN", lot_number: "LH3002", expiry_date: "2027-04-30", qty_units: 40, received_on: "2026-04-15", po_number: "PO-26-0391", note: "NOT AFFECTED" },
  { item_id: "RX-BICARB-84-50-FK", location_code: "MAIN", lot_number: "6152871", expiry_date: "2027-12-31", qty_units: 25, received_on: "2026-09-02", po_number: "PO-26-0877", note: "ALTERNATIVE on hand" },
  // Ketorolac 60 mg/2 mL, recall D-0036-2026: lots AS1240347A (09/2026), AS1240144A (05/2026), AS1240145A, AS1240146A (06/2026), AS1250295A (05/2027)
  { item_id: "RX-KETO-60-2", location_code: "ED", lot_number: "AS1250295A", expiry_date: "2027-05-31", qty_units: 30, received_on: "2026-01-20", po_number: "PO-26-0044", note: "AFFECTED" },
  { item_id: "RX-KETO-60-2", location_code: "MAIN", lot_number: "AS1240347A", expiry_date: "2026-09-30", qty_units: 5, received_on: "2025-10-02", po_number: "PO-25-0918", note: "AFFECTED and already EXPIRED: should not be on the shelf at all" },
  { item_id: "RX-KETO-60-2", location_code: "MAIN", lot_number: "AS1260011B", expiry_date: "2028-01-31", qty_units: 60, received_on: "2026-08-12", po_number: "PO-26-0812", note: "NOT AFFECTED" },
];

export const PURCHASE_ORDERS = [
  { po_number: "PO-26-1012", item_id: "RX-ROPI-05-20", packs: 4, ordered_on: "2026-10-20", expected_on: "2026-10-28", status: "open", supplier: "MedLine Distribution (fictional)" },
  { po_number: "PO-26-1015", item_id: "RX-BICARB-84-50", packs: 6, ordered_on: "2026-10-21", expected_on: "2026-10-30", status: "open", supplier: "MedLine Distribution (fictional)" },
  { po_number: "PO-26-1001", item_id: "RX-FURO-80-TAB", packs: 10, ordered_on: "2026-10-12", expected_on: "2026-10-26", status: "open", supplier: "MedLine Distribution (fictional)" },
];

// Wholesaler catalog rows: orderable NDCs and the wholesaler's own availability, which does
// not always agree with FDA's shortage list. Like most catalog exports that pass through a
// spreadsheet, the NDC column holds plain numbers, so labelers starting with 0 lose digits.
export const CATALOG_NDCS: { ndc: string; status: string; eta: string | null; note: string }[] = [
  { ndc: "63323-286-23", status: "Allocation", eta: null, note: "recalled presentation (other lots)" },
  { ndc: "70069-063-25", status: "Backorder", eta: "2026-11-15", note: "FDA says Available; wholesaler disagrees" },
  { ndc: "55150-197-20", status: "Available", eta: null, note: "Eugia ropivacaine 0.5% 20 mL" },
  { ndc: "43066-019-10", status: "Available", eta: null, note: "Baxter-labelled ropivacaine 0.5% (labeler 43066); Baxter is not the recalling firm for ropivacaine" },
  { ndc: "68462-778-55", status: "Available", eta: null, note: "Glenmark ropivacaine 0.5% 20 mL, not on FDA shortage list" },
  { ndc: "0338-0719-06", status: "Available", eta: null, note: "recalled presentation" },
  { ndc: "0990-7918-19", status: "Available", eta: null, note: "ICU Medical dextrose 70% 500 mL: different volume" },
  { ndc: "0338-3814-24", status: "Available", eta: null, note: "recalled presentation" },
  { ndc: "43066-995-24", status: "Available", eta: null, note: "Baxter (labeler 43066) clindamycin 900 mg: same recalling firm" },
  { ndc: "72572-074-24", status: "Available", eta: null, note: "Civica clindamycin 12 mg/mL = 600 mg/50 mL: different strength" },
  { ndc: "0143-9269-01", status: "Available", eta: null, note: "Hikma clindamycin 18 mg/mL vial (not premixed)" },
  { ndc: "69315-118-01", status: "Available", eta: null, note: "recalled presentation" },
  { ndc: "0054-4301-25", status: "Available", eta: null, note: "Hikma furosemide 80 mg" },
  { ndc: "43547-403-10", status: "Available", eta: null, note: "Solco furosemide 80 mg" },
  { ndc: "0409-6637-14", status: "Backorder", eta: "2026-12-01", note: "recalled presentation" },
  { ndc: "63323-089-50", status: "Available", eta: null, note: "Fresenius sodium bicarbonate 8.4% vial" },
  { ndc: "76329-3352-1", status: "Allocation", eta: null, note: "IMS sodium bicarbonate syringe: FDA Limited Availability" },
  { ndc: "31722-307-25", status: "Available", eta: null, note: "recalled presentation" },
  { ndc: "0641-6043-25", status: "Available", eta: null, note: "Hikma ketorolac 30 mg/mL: FDA says Unavailable; conflict" },
  { ndc: "25021-701-02", status: "Available", eta: null, note: "Sagent ketorolac 30 mg/mL" },
  { ndc: "72266-119-25", status: "Available", eta: null, note: "Fosun ketorolac 30 mg/mL" },
];

export function buildHospital() {
  const items = ITEM_SPECS.map(s => {
    const p = pkg(s.ndc);
    return {
      item_id: s.item_id,
      ndc11: toNdc11(s.ndc)!,
      description: s.description,
      generic_name: p.generic_name.toLowerCase(),
      strength: s.strength,
      dosage_form: p.dosage_form,
      route: p.route,
      manufacturer: p.labeler_name,
      unit_of_issue: s.unit,
      units_per_pack: s.units_per_pack,
      formulary_status: s.formulary,
    };
  });

  // Deterministic dispensing history: 90 days ending on DEMO_DATE, per item and location.
  let seed = 20261024;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const dispensing: { item_id: string; location_code: string; day: string; units: number }[] = [];
  const end = new Date(`${DEMO_DATE}T00:00:00Z`);
  for (const s of ITEM_SPECS) {
    if (s.daily_use === 0) continue;
    const locs = [...new Set(LOT_SPECS.filter(l => l.item_id === s.item_id).map(l => l.location_code))];
    for (let d = 89; d >= 0; d--) {
      const day = new Date(end.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      const weekday = new Date(day).getUTCDay();
      const factor = weekday === 0 || weekday === 6 ? 0.7 : 1.1;
      for (const loc of locs) {
        const mean = (s.daily_use * factor) / locs.length;
        const units = Math.max(0, Math.round(mean + (rand() - 0.5) * mean));
        if (units > 0) dispensing.push({ item_id: s.item_id, location_code: loc, day, units });
      }
    }
  }

  const lots = LOT_SPECS.map((l, i) => ({ lot_row_id: i + 1, item_id: l.item_id, location_code: l.location_code, lot_number: l.lot_number, expiry_date: l.expiry_date, qty_units: l.qty_units, received_on: l.received_on, po_number: l.po_number }));
  const answerKey = LOT_SPECS.map((l, i) => ({ lot_row_id: i + 1, item_id: l.item_id, location_code: l.location_code, lot_number: l.lot_number, note: l.note }));

  const catalog = CATALOG_NDCS.map((c, i) => {
    const p = pkg(c.ndc);
    return {
      wholesaler_item: `MLD-${String(410200 + i * 7)}`,
      ndc: String(Number(toNdc11(c.ndc)!)),
      description: `${p.generic_name} ${p.active_ingredients.replace(/^[A-Z ,]+ /, "")} ${p.dosage_form}`.toUpperCase().slice(0, 60),
      manufacturer: p.labeler_name,
      pack: p.package_description.split("/")[0]!.replace(/\s*\([\d-]+\)\s*/g, " ").trim().slice(0, 50),
      status: c.status,
      eta: c.eta,
    };
  });

  return { locations: LOCATIONS, items, lots, dispensing, purchaseOrders: PURCHASE_ORDERS, catalog, answerKey };
}
