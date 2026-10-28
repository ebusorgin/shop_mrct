import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./pages/dashboard.component').then((m) => m.DashboardComponent) },
  { path: 'waybills', loadComponent: () => import('./pages/waybills.component').then((m) => m.WaybillsComponent) },
  { path: 'stock', loadComponent: () => import('./pages/stock.component').then((m) => m.StockComponent) },
  { path: 'semis', loadComponent: () => import('./pages/semis.component').then((m) => m.SemisComponent) },
  { path: 'cards', loadComponent: () => import('./pages/cards.component').then((m) => m.CardsComponent) },
  { path: 'batches', loadComponent: () => import('./pages/batches.component').then((m) => m.BatchesComponent) },
  { path: 'orders', loadComponent: () => import('./pages/orders.component').then((m) => m.OrdersComponent) },
  { path: 'orders/:storeId', loadComponent: () => import('./pages/order-store.component').then((m) => m.OrderStoreComponent) },
  { path: '**', redirectTo: '' },
];
