import { runExperimentBootstrap } from './experiment-bootstrap';

runExperimentBootstrap();

const D = document;
const sc = D.createElement('script');
sc.src = 'https://js.growthroadmaps.com/growth.min.js';
sc.async = true;
D.head.appendChild(sc);
