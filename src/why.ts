// Entry for the static why.html page: fonts and the theme toggle.
import { bindThemeToggle } from './theme';

const toggle = document.querySelector<HTMLButtonElement>('.theme-toggle');
if (toggle) bindThemeToggle(toggle);
