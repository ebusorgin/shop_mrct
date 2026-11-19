import { Routes } from '@angular/router';
import { authGuard, adminGuard, officeGuard, storeGuard } from './core/auth.guard';
import { unsavedChangesGuard } from './core/unsaved.guard';

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
      {
        path: 'store/orders',
        canActivate: [storeGuard],
        loadComponent: () => import('./orders/store-orders.component').then((m) => m.StoreOrdersComponent),
      },
      {
        path: 'store/history',
        canActivate: [storeGuard],
        data: { storeMode: true },
        loadComponent: () => import('./orders/orders.component').then((m) => m.OrdersComponent),
      },
      {
        path: 'store/history/report',
        canActivate: [storeGuard],
        data: { storeMode: true },
        loadComponent: () => import('./orders/report.component').then((m) => m.OrderReportComponent),
      },
      // офисная CRM: магазинному сотруднику закрыта (уводим на /store)
      {
        path: '',
        canActivateChild: [officeGuard],
        children: [
          { path: '', pathMatch: 'full', loadComponent: () => import('./pages/dashboard.component').then((m) => m.DashboardComponent) },
          { path: 'waybills', loadComponent: () => import('./pages/waybills.component').then((m) => m.WaybillsComponent) },
          { path: 'stock', loadComponent: () => import('./pages/stock.component').then((m) => m.StockComponent) },
          // рецептуры и заготовки живут в разделе «Рецептуры»; старую карту убрали
          { path: 'semis', pathMatch: 'full', redirectTo: 'recipes' },
          { path: 'cards', pathMatch: 'full', redirectTo: 'recipes' },
          { path: 'map', pathMatch: 'full', redirectTo: 'recipes' },
          { path: 'recipes', canDeactivate: [unsavedChangesGuard], loadComponent: () => import('./pages/recipes.component').then((m) => m.RecipesComponent) },
          // старые адреса конструктора ведут в «Рецептуры»
          { path: 'constructor', pathMatch: 'full', redirectTo: 'recipes' },
          { path: 'constructor/map', pathMatch: 'full', redirectTo: 'recipes' },
          { path: 'orders', loadComponent: () => import('./orders/orders.component').then((m) => m.OrdersComponent) },
          {
            path: 'orders/report',
            loadComponent: () => import('./orders/report.component').then((m) => m.OrderReportComponent),
          },
          { path: 'suppliers', loadComponent: () => import('./pages/suppliers.component').then((m) => m.SuppliersComponent) },
          { path: 'points', loadComponent: () => import('./pages/points.component').then((m) => m.PointsComponent) },
          {
            path: 'points/:id',
            loadComponent: () =>
              import('./pages/point-detail.component').then((m) => m.PointDetailComponent),
          },
          // журнал действий переехал во вкладку «Аудит» настроек
          { path: 'audit', redirectTo: 'settings', pathMatch: 'full' },
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
