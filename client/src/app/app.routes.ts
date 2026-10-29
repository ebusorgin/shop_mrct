import { Routes } from '@angular/router';
import { authGuard, adminGuard, officeGuard, storeGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login.component').then((m) => m.LoginComponent) },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      // магазинный сотрудник: только страница своего магазина
      {
        path: 'store',
        canActivate: [storeGuard],
        loadComponent: () => import('./pages/store-home.component').then((m) => m.StoreHomeComponent),
      },
      // офисная CRM: магазинному сотруднику закрыта (уводим на /store)
      {
        path: '',
        canActivateChild: [officeGuard],
        children: [
          { path: '', pathMatch: 'full', loadComponent: () => import('./pages/dashboard.component').then((m) => m.DashboardComponent) },
          { path: 'waybills', loadComponent: () => import('./pages/waybills.component').then((m) => m.WaybillsComponent) },
          { path: 'stock', loadComponent: () => import('./pages/stock.component').then((m) => m.StockComponent) },
          { path: 'semis', loadComponent: () => import('./pages/semis.component').then((m) => m.SemisComponent) },
          { path: 'cards', loadComponent: () => import('./pages/cards.component').then((m) => m.CardsComponent) },
          { path: 'batches', loadComponent: () => import('./pages/batches.component').then((m) => m.BatchesComponent) },
          { path: 'points', loadComponent: () => import('./pages/points.component').then((m) => m.PointsComponent) },
          { path: 'points/:id', loadComponent: () => import('./pages/point-detail.component').then((m) => m.PointDetailComponent) },
          { path: 'orders', loadComponent: () => import('./pages/orders.component').then((m) => m.OrdersComponent) },
          { path: 'orders/:storeId', loadComponent: () => import('./pages/order-store.component').then((m) => m.OrderStoreComponent) },
          { path: 'audit', loadComponent: () => import('./pages/audit.component').then((m) => m.AuditComponent) },
          {
            path: 'users',
            canActivate: [adminGuard],
            loadComponent: () => import('./pages/users.component').then((m) => m.UsersComponent),
          },
          {
            path: 'settings',
            canActivate: [adminGuard],
            loadComponent: () => import('./pages/settings.component').then((m) => m.SettingsComponent),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
