-- Fix typo: "condig" -> "config" in script name
UPDATE scripts SET name = REPLACE(name, 'condig', 'config') WHERE name LIKE '%condig%';
