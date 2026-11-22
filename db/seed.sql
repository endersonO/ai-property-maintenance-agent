-- Synthetic UK data. Readable IDs keep evals and demos legible.

insert into agencies (id, name) values
  ('agency_northbridge', 'Northbridge Lettings'),
  ('agency_harbour_lane', 'Harbour Lane Estates');

-- Northbridge: routine repairs go straight through; review for emergencies or > £250.
-- Harbour Lane: stricter rules and reviewAboveGbp = 0, so everything is reviewed.
insert into policies (agency_id, version, active, rules) values
  ('agency_northbridge', 1, true, '{
    "rules": [
      { "if": { "hazardsAny": ["gas_smell", "active_water_leak", "electrical_hazard"] },
        "priority": "emergency", "forceReview": true },
      { "if": { "category": "heating", "hazardsAny": ["no_heating"] }, "priority": "high" },
      { "if": { "hazardsAny": ["security_risk"] }, "priority": "high" }
    ],
    "defaultPriority": "normal",
    "costEstimatesGbp": { "plumbing": 180, "electrical": 300, "heating": 400, "appliance": 120 },
    "defaultCostEstimateGbp": 150,
    "reviewAboveGbp": 250
  }'::jsonb),
  ('agency_harbour_lane', 1, true, '{
    "rules": [
      { "if": { "hazardsAny": ["gas_smell", "active_water_leak", "electrical_hazard"] },
        "priority": "emergency", "forceReview": true },
      { "if": { "hazardsAny": ["no_heating", "no_hot_water", "security_risk"] }, "priority": "high" }
    ],
    "defaultPriority": "normal",
    "costEstimatesGbp": { "plumbing": 220, "electrical": 350, "heating": 450, "appliance": 150 },
    "defaultCostEstimateGbp": 180,
    "reviewAboveGbp": 0
  }'::jsonb);

insert into properties (id, agency_id, address, city, postcode) values
  ('prop_mcr_1', 'agency_northbridge',  'Flat 4, 18 Mill Lane',      'Manchester', 'M4 6AB'),
  ('prop_lds_1', 'agency_northbridge',  '27 Kirkgate Row',           'Leeds',      'LS2 7DJ'),
  ('prop_bri_1', 'agency_harbour_lane', 'Flat 2, 9 Quayside Court',  'Bristol',    'BS1 4RT');

insert into tenants (id, name, email, property_id) values
  ('tenant_olivia', 'Olivia Bennett', 'olivia.bennett@example.com', 'prop_mcr_1'),
  ('tenant_james',  'James Okafor',   'james.okafor@example.com',   'prop_lds_1'),
  ('tenant_priya',  'Priya Shah',     'priya.shah@example.com',     'prop_bri_1');
