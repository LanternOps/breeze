import { beforeEach } from 'vitest';
import { installOfficeMock } from './officeMock';

beforeEach(() => {
  installOfficeMock();
  sessionStorage.clear();
});
