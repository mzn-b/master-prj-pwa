import './App.css'
import {useState} from "react";
import {CameraScreen} from "./screens/CameraScreen.tsx";
import {ConsentGate} from "./ui/ConsentGate";

function App() {
    // Gate the whole app rather than the Start button: consent has to precede
    // processing, and this way the camera cannot be reached without it. Held in
    // state, not storage — see the note in ConsentGate.
    const [consented, setConsented] = useState(false);

    if (!consented) {
        return <ConsentGate onAccept={() => setConsented(true)}/>
    }

    return <CameraScreen/>
}

export default App
