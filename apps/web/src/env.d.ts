/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    locale?: import('@breeze/shared').SupportedLocale;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_ENABLE_ENDPOINT_AV_FEATURES?: string;
  readonly PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST?: string;
}
