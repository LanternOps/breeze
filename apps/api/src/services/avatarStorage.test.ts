import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, setMock, whereMock, returningMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { update: updateMock } }));
vi.mock('../db/schema', () => ({ users: { id: {} } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), sql: vi.fn() }));

import { writeAvatar } from './avatarStorage';

describe('writeAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockReturnValue({ set: setMock });
    setMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ returning: returningMock });
    returningMock.mockImplementation(async () => [{ id: 'user-1', updatedAt: new Date() }]);
  });

  it('stores a versioned URL so replacing bytes invalidates cached avatar responses', async () => {
    const result = await writeAvatar('user-1', 'image/png', Buffer.from('avatar bytes'));

    expect(result?.avatarUrl).toMatch(/^\/api\/v1\/users\/user-1\/avatar\?v=[\da-f-]{36}$/);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: result?.avatarUrl }));
  });
});
