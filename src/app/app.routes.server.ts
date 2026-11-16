import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Prerender
  },
  {
    path: "home",
    renderMode: RenderMode.Server
  },
  {
    path: "trends",
    renderMode: RenderMode.Server
  },
  {
    path:"project",
    renderMode:RenderMode.Client
  }
];
