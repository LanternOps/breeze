-- Seed Breeze-curated catalog with common third-party apps via winget.
-- ON CONFLICT DO NOTHING so re-running is a no-op.

INSERT INTO third_party_package_catalog
  (source, package_id, vendor, friendly_name, category, default_severity, breeze_tested, homepage_url)
VALUES
  ('third_party', 'Google.Chrome',        'Google',    'Google Chrome',         'application', 'important', false, 'https://www.google.com/chrome/'),
  ('third_party', 'Mozilla.Firefox',      'Mozilla',   'Mozilla Firefox',       'application', 'important', false, 'https://www.mozilla.org/firefox/'),
  ('third_party', 'Mozilla.Firefox.ESR',  'Mozilla',   'Firefox ESR',           'application', 'important', false, 'https://www.mozilla.org/firefox/enterprise/'),
  ('third_party', 'Microsoft.Edge',       'Microsoft', 'Microsoft Edge',        'application', 'important', false, 'https://www.microsoft.com/edge'),
  ('third_party', 'Zoom.Zoom',            'Zoom',      'Zoom',                  'application', 'important', false, 'https://zoom.us/'),
  ('third_party', 'Microsoft.Teams',      'Microsoft', 'Microsoft Teams',       'application', 'important', false, 'https://teams.microsoft.com'),
  ('third_party', 'SlackTechnologies.Slack', 'Slack',  'Slack',                 'application', 'moderate',  false, 'https://slack.com'),
  ('third_party', 'OBSProject.OBSStudio', 'OBS Project','OBS Studio',           'application', 'low',       false, 'https://obsproject.com'),
  ('third_party', '7zip.7zip',            '7zip',      '7-Zip',                 'application', 'moderate',  false, 'https://7-zip.org'),
  ('third_party', 'VideoLAN.VLC',         'VideoLAN',  'VLC media player',      'application', 'moderate',  false, 'https://videolan.org'),
  ('third_party', 'Notepad++.Notepad++',  'Notepad++', 'Notepad++',             'application', 'low',       false, 'https://notepad-plus-plus.org'),
  ('third_party', 'Adobe.Acrobat.Reader.64-bit', 'Adobe', 'Adobe Acrobat Reader','application', 'important', false, 'https://www.adobe.com/acrobat/pdf-reader.html'),
  ('third_party', 'Oracle.JavaRuntimeEnvironment', 'Oracle', 'Java Runtime',    'application', 'important', false, 'https://www.java.com'),
  ('third_party', 'OpenJS.NodeJS.LTS',    'OpenJS',    'Node.js LTS',           'application', 'important', false, 'https://nodejs.org'),
  ('third_party', 'Python.Python.3.12',   'Python',    'Python 3.12',           'application', 'important', false, 'https://www.python.org'),
  ('third_party', 'Git.Git',              'Git',       'Git',                   'application', 'moderate',  false, 'https://git-scm.com'),
  ('third_party', 'Microsoft.VisualStudioCode', 'Microsoft', 'Visual Studio Code','application', 'moderate', false, 'https://code.visualstudio.com'),
  ('third_party', 'PuTTY.PuTTY',          'PuTTY',     'PuTTY',                 'application', 'moderate',  false, 'https://www.putty.org'),
  ('third_party', 'WinSCP.WinSCP',        'WinSCP',    'WinSCP',                'application', 'moderate',  false, 'https://winscp.net'),
  ('third_party', 'TeamViewer.TeamViewer', 'TeamViewer', 'TeamViewer',          'application', 'important', false, 'https://www.teamviewer.com')
ON CONFLICT (source, package_id) DO NOTHING;
