import { Routes } from '@angular/router';
import { Home } from './pages/home/home';
import { Trends } from './components/trend/trend';

export const routes: Routes = [
    { path: 'home', component: Home },
    // Sem componente: o globo já está montado no app.html; a rota só existe para o link e o "ativo" do menu
    { path: 'project', children: [] },
    { path: 'trends', component:Trends },
    { path: '**', redirectTo: 'home' }
];