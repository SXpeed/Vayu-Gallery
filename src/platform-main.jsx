import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProductionShell} from './platform-auth.jsx';
import {GalleryWorkspace} from './platform-workspace.jsx';
import './styles.css';
import './catalog.css';
import './platform-workspace.css';
createRoot(document.getElementById('root')).render(<ProductionShell renderWorkspace={props=><GalleryWorkspace key={`${props.gallery.id}:${props.providerAccessId||''}`} {...props}/>}/>);
