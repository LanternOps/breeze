// cytoscape-fcose ships no type declarations (#1728). It is a Cytoscape layout
// extension registered via `cytoscape.use(fcose)`; the default export is the
// extension registration function.
declare module 'cytoscape-fcose' {
  import type cytoscape from 'cytoscape';
  const ext: cytoscape.Ext;
  export default ext;
}
