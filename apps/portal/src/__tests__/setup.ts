import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Testing Library's 1 s default for waitFor/findBy* is shorter than a loaded CI runner can
// take to flush a fetch -> setState -> re-render chain (#8033: portal component tests failed
// at ~1.1 s on PRs that never touched portal code). Passing assertions return as soon as they
// hold, so this only changes how long a genuinely failing one takes to report.
configure({ asyncUtilTimeout: 5000 });
