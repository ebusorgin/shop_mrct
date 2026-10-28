import { bootstrapApplication } from '@angular/platform-browser';
import { provideAppInitializer, inject } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { authInterceptor } from './app/core/auth.interceptor';
import { AuthService } from './app/core/auth.service';

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    // сессию проверяем до первой навигации, иначе guard отправит на /login даже вошедшего
    provideAppInitializer(() => inject(AuthService).load()),
  ],
}).catch((err) => console.error(err));
