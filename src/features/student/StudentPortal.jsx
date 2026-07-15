import { useState, useEffect } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { supabase } from '../../lib/supabase';

export default function StudentPortal() {
  // 1. Hardware Binding: Get or Create the secret device token
  const getDeviceToken = () => {
    let token = localStorage.getItem('secure_device_token');
    if (!token) {
      // Create a unique identifier for this specific phone/browser
      token = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('secure_device_token', token);
    }
    return token;
  };

  const [studentContext, setStudentContext] = useState(() => {
    const saved = localStorage.getItem('student_context');
    return saved ? JSON.parse(saved) : null;
  });

  const [studentIdInput, setStudentIdInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [scanStatus, setScanStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('Ready to Scan');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);

    try {
      const deviceToken = getDeviceToken();

      // Step 1: Find the student in the database
      const { data: studentData, error: studentError } = await supabase
        .from('students')
        .select('id, user_id, users(first_name, last_name)')
        .eq('student_id_number', studentIdInput.trim())
        .maybeSingle();

      if (studentError || !studentData) {
        setLoginError('Student ID not found. Please ask your teacher to register you.');
        setIsLoggingIn(false);
        return;
      }

      // Step 2: Hardware Security Check
      const { data: deviceData } = await supabase
        .from('devices')
        .select('*')
        .eq('user_id', studentData.user_id)
        .maybeSingle();

      if (deviceData) {
        // A device is already registered to this student. Does it match this phone?
        if (deviceData.device_fingerprint !== deviceToken) {
          setLoginError('SECURITY ALERT: This Student ID is locked to another device. If you got a new phone, ask your teacher to reset your pairing.');
          setIsLoggingIn(false);
          return;
        }
      } else {
        // First time logging in! Lock this phone to the database.
        const { error: insertDeviceError } = await supabase
          .from('devices')
          .insert({
            user_id: studentData.user_id,
            device_fingerprint: deviceToken
          });

        if (insertDeviceError) {
          setLoginError('Failed to securely bind device to database.');
          setIsLoggingIn(false);
          return;
        }
      }

      // Step 3: Success! Save context and reveal scanner
      const context = {
        id: studentData.id,
        firstName: studentData.users.first_name,
        lastName: studentData.users.last_name,
        studentId: studentIdInput.trim()
      };
      
      setStudentContext(context);
      localStorage.setItem('student_context', JSON.stringify(context));

    } catch (err) {
      setLoginError('A database connection error occurred.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const processQrPayload = async (payload) => {
    if (scanStatus === 'scanning' || scanStatus === 'success') return;
    
    setScanStatus('scanning');
    setStatusMessage('Validating Cryptographic Token...');

    try {
      const { data: tokenData, error: tokenError } = await supabase
        .from('qr_tokens')
        .select('*, session:attendance_sessions(*)')
        .eq('payload', payload)
        .single();

      if (tokenError || !tokenData) throw new Error('Invalid or unrecognized QR code.');

      const now = new Date();
      const tokenExpiresAt = new Date(tokenData.expires_at);
      if (now > tokenExpiresAt) throw new Error('Token expired. Please wait for the QR code to rotate.');

      const sessionStart = new Date(tokenData.session.start_time);
      const sessionEnd = new Date(tokenData.session.end_time);
      const lateThreshold = new Date(tokenData.session.late_threshold);

      if (now < sessionStart) throw new Error('This session has not started yet.');
      if (now > sessionEnd) throw new Error('This session has concluded.');

      const finalStatus = now > lateThreshold ? 'LATE' : 'PRESENT';

      const { error: insertError } = await supabase.from('attendance_logs').insert([
        { session_id: tokenData.session_id, student_id: studentContext.id, status: finalStatus }
      ]);

      if (insertError) {
        if (insertError.code === '23505') {
          setScanStatus('duplicate');
          setStatusMessage('You are already recorded.');
          setTimeout(() => resetScanner(), 4000);
          return;
        }
        throw new Error('Failed to record attendance. Please try again.');
      }

      setScanStatus('success');
      setStatusMessage(finalStatus === 'LATE' ? 'Recorded Late' : 'Recorded Present');
      setTimeout(() => resetScanner(), 4000);

    } catch (err) {
      setScanStatus('error');
      setStatusMessage(err.message);
      setTimeout(() => resetScanner(), 4000);
    }
  };

  const resetScanner = () => {
    setScanStatus('idle');
    setStatusMessage('Ready to Scan');
  };

  if (!studentContext) {
    return (
      <div className="max-w-md mx-auto bg-white min-h-[600px] flex flex-col shadow-xl border border-gray-100 rounded-3xl overflow-hidden relative">
        <div className="bg-blue-600 text-white p-6 text-center shadow-md">
          <h2 className="text-2xl font-bold tracking-tight">Student Portal</h2>
          <p className="text-blue-100 text-sm mt-1">Identify Yourself</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gray-50">
          <form onSubmit={handleLogin} className="w-full bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <h3 className="text-lg font-bold text-gray-800 mb-2 text-center">Enter Student ID</h3>
            <p className="text-xs text-gray-500 mb-6 text-center">
              This device will be permanently locked to your ID to prevent proxy scanning.
            </p>
            <input 
              type="text" 
              value={studentIdInput}
              onChange={(e) => setStudentIdInput(e.target.value)}
              placeholder="e.g. STU-1234"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              required
            />
            {loginError && (
              <div className="bg-red-50 border-l-4 border-red-500 p-3 mb-4 rounded">
                <p className="text-red-700 text-xs font-semibold">{loginError}</p>
              </div>
            )}
            <button 
              type="submit" 
              disabled={isLoggingIn}
              className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition disabled:bg-blue-400"
            >
              {isLoggingIn ? 'Verifying...' : 'Access Scanner'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto bg-white min-h-[600px] flex flex-col shadow-xl border border-gray-100 rounded-3xl overflow-hidden relative">
      <div className="bg-blue-600 text-white p-6 text-center shadow-md z-10 flex justify-between items-center">
        <div className="text-left">
          <h2 className="text-xl font-bold tracking-tight">{studentContext.firstName} {studentContext.lastName}</h2>
          <p className="text-blue-100 text-sm mt-1">{studentContext.studentId}</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gray-50">
        <div className="relative w-full aspect-square max-w-[300px] bg-black rounded-3xl overflow-hidden shadow-inner border-4 border-gray-800 mb-8">
          {(scanStatus === 'idle' || scanStatus === 'scanning') && (
            <Scanner 
              onScan={(result) => {
                if (result && result.length > 0) processQrPayload(result[0].rawValue);
              }}
              onError={(error) => console.log(error?.message)}
              components={{ audio: false, finder: false }}
              styles={{ container: { width: '100%', height: '100%' } }}
            />
          )}

          {scanStatus === 'scanning' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-sm z-10">
              <span className="text-white font-bold animate-pulse">Processing...</span>
            </div>
          )}

          {scanStatus === 'success' && (
            <div className="absolute inset-0 bg-green-500/90 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300 z-10">
              <span className="text-white font-bold text-lg tracking-wide">Recorded</span>
            </div>
          )}

          {scanStatus === 'error' && (
            <div className="absolute inset-0 bg-red-500/90 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300 z-10">
              <span className="text-white font-bold text-lg tracking-wide text-center px-4">Scan Failed</span>
            </div>
          )}

          {scanStatus === 'duplicate' && (
            <div className="absolute inset-0 bg-yellow-500/90 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300 z-10">
              <span className="text-white font-bold text-lg tracking-wide text-center px-4">Already Logged</span>
            </div>
          )}
        </div>

        <div className="text-center w-full px-4">
          <h3 className={`text-lg font-bold ${scanStatus === 'error' ? 'text-red-600' : scanStatus === 'duplicate' ? 'text-yellow-600' : 'text-gray-800'}`}>
            {statusMessage}
          </h3>
          <p className="text-sm text-gray-500 mt-2">
            {scanStatus === 'idle' ? "Point your camera at the teacher's screen to log your attendance." : ""}
          </p>
        </div>
      </div>
    </div>
  );
}