-- Software policies are now pure templates (rules + enforcement only).
-- Device targeting is handled exclusively through Configuration Policy assignments.
-- Make target_type nullable since new policies no longer set it.
ALTER TABLE software_policies ALTER COLUMN target_type DROP NOT NULL;
