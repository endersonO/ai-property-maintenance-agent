-- Synthetic UK data. Readable IDs keep evals and demos legible.

insert into agencies (id, name, acquired_on, history_starts_on, onboarded_on) values
  ('agency_northbridge', 'Northbridge Lettings', null, null, null),
  ('agency_harbour_lane', 'Harbour Lane Estates', null, null, null),
  -- Joined by acquisition: history only from the acquisition, onboarded three months later.
  ('agency_riverside', 'Riverside Homes', '2026-03-01', '2026-03-01', '2026-06-01');

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
  }'::jsonb),
  -- Riverside: its own pre-acquisition rules, kept as data; review above £300.
  ('agency_riverside', 1, true, '{
    "rules": [
      { "if": { "hazardsAny": ["gas_smell", "electrical_hazard"] },
        "priority": "emergency", "forceReview": true },
      { "if": { "hazardsAny": ["active_water_leak", "no_heating"] }, "priority": "high" }
    ],
    "defaultPriority": "normal",
    "costEstimatesGbp": { "plumbing": 160, "electrical": 280, "heating": 380, "appliance": 110 },
    "defaultCostEstimateGbp": 140,
    "reviewAboveGbp": 300
  }'::jsonb);

insert into properties (id, agency_id, address, city, postcode) values
  ('prop_mcr_1', 'agency_northbridge',  'Flat 4, 18 Mill Lane',      'Manchester', 'M4 6AB'),
  ('prop_lds_1', 'agency_northbridge',  '27 Kirkgate Row',           'Leeds',      'LS2 7DJ'),
  ('prop_bri_1', 'agency_harbour_lane', 'Flat 2, 9 Quayside Court',  'Bristol',    'BS1 4RT');

insert into tenants (id, name, email, property_id) values
  ('tenant_olivia', 'Olivia Bennett', 'olivia.bennett@example.com', 'prop_mcr_1'),
  ('tenant_james',  'James Okafor',   'james.okafor@example.com',   'prop_lds_1'),
  ('tenant_priya',  'Priya Shah',     'priya.shah@example.com',     'prop_bri_1');

-- Simulated manager sessions for the operations brief.
insert into managers (id, name) values
  ('manager_north', 'Alex Morgan (North region)'),
  ('manager_ops',   'Sam Taylor (Operations director)');

insert into manager_agencies (manager_id, agency_id) values
  ('manager_north', 'agency_northbridge'),
  ('manager_north', 'agency_riverside'),
  ('manager_ops',   'agency_northbridge'),
  ('manager_ops',   'agency_harbour_lane'),
  ('manager_ops',   'agency_riverside');
