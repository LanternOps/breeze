export type DeviceOption = {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  status: string;
  siteId: string | null;
  siteName: string | null;
};

export type DeviceOptionPage = {
  data: DeviceOption[];
  page: {
    nextCursor: string | null;
    returned: number;
    total: number;
    hasMore: boolean;
    observedAt: string;
  };
};
