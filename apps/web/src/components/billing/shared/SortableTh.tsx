// Re-export shim: the component now lives in components/shared (account board
// W02). Billing callers keep this import path; new callers import from
// '@/components/shared/SortableTh' and pass `namespace`.
export { SortableTh, type SortableThProps } from '../../shared/SortableTh';
export { default } from '../../shared/SortableTh';
