
export default {
  bootstrap: () => import('./main.server.mjs').then(m => m.default),
  baseHref: "/",
  criticalCssPlans: [[1,"/styles-HWJLYGMO.css",36,[],[],[[5,".body","{margin:0!important;padding:0}",[1]]]]],
  locale: undefined,
  routes: [
  {
    "renderMode": 0,
    "route": "/home"
  },
  {
    "renderMode": 1,
    "route": "/project"
  },
  {
    "renderMode": 0,
    "route": "/trends"
  },
  {
    "renderMode": 2,
    "redirectTo": "/home",
    "relativeRedirect": true,
    "route": "/**"
  }
],
  entryPointToBrowserMapping: undefined,
  assets: {
    "index.csr.html": {size: 837, hash: "eaa6373dbf2789eb", text: () => import("./assets-chunks/index_csr_html.mjs").then(m => m.default)},
    "index.server.html": {size: 1009, hash: "be6192596aa5d139", text: () => import("./assets-chunks/index_server_html.mjs").then(m => m.default)}
  },
};
