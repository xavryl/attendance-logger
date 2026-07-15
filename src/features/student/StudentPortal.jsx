import { useState, useEffect } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { supabase } from '../../lib/supabase';

export default function StudentPortal() {
  const [scanStatus, setScanStatus] = useState('idle'); // idle, scanning, success, error, duplicate
  const [statusMessage, setStatusMessage] = useState('Ready to Scan');
  const [studentContext, setStudentContext] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch the dummy student on load
  useEffect(() => {
    async function fetchTestStudent() {
      const { data, error } = await supabase.from('students').select('id').limit(1).single();
      if (data) {
        setStudentContext(data);
      } else {
        console.error("No test student found. Did you run the SQL seed script?", error);
        setStatusMessage('Database Error: No Student Found');
      }
      setIsLoading(false);
    }
    fetchTestStudent();
  }, []);

  const processQrPayload = async (payload) => {
    // Prevent multiple rapid scans
    if (scanStatus === 'scanning' || scanStatus === 'success') return;
    
    setScanStatus('scanning');
    setStatusMessage('Validating Cryptographic Token...');

    try {
      // 1. Find the token in the database
      const { data: tokenData, error: tokenError } = await supabase
        .from('qr_tokens')
        .select('*')
        .eq('payload', payload)
        .single();

      if (tokenError || !tokenData) {
        throw new Error('Invalid or unrecognized QR code.');
      }

      // 2. Check Expiration
      const now = new Date();
      const expiresAt = new Date(tokenData.expires_at);
      
      if (now > expiresAt) {
        throw new Error('Token expired. Please wait for the QR code to rotate.');
      }

      // 3. Insert Attendance Log
      const { error: insertError } = await supabase.from('attendance_logs').insert([
        {
          session_id: tokenData.session_id,
          student_id: studentContext.id,
          status: 'PRESENT'
        }
      ]);

      if (insertError) {
        // Postgres Error 23505 is a Unique Violation (Double-Scan Shield)
        if (insertError.code === '23505') {
          setScanStatus('duplicate');
          setStatusMessage('You are already marked present for this session.');
          setTimeout(() => resetScanner(), 4000);
          return;
        }
        throw new Error('Failed to record attendance. Please try again.');
      }

      // Success
      setScanStatus('success');
      setStatusMessage('Attendance Logged Successfully!');
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

  if (isLoading) return <div className="p-8 text-center">Loading database connection...</div>;

  return (
    <div className="max-w-md mx-auto bg-white min-h-[600px] flex flex-col shadow-xl border border-gray-100 rounded-3xl overflow-hidden relative">
      
      <div className="bg-blue-600 text-white p-6 text-center shadow-md z-10">
        <h2 className="text-2xl font-bold tracking-tight">Student Portal</h2>
        <p className="text-blue-100 text-sm mt-1">CS101 - Intro to Programming</p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gray-50">
        
        <div className="relative w-full aspect-square max-w-[300px] bg-black rounded-3xl overflow-hidden shadow-inner border-4 border-gray-800 mb-8">
          
          {(scanStatus === 'idle' || scanStatus === 'scanning') && studentContext && (
            <Scanner 
              onScan={(result) => {
                if (result && result.length > 0) {
                  processQrPayload(result[0].rawValue);
                }
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
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-2 shadow-lg">
                <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
              </div>
              <span className="text-white font-bold text-lg tracking-wide">Present</span>
            </div>
          )}

          {scanStatus === 'error' && (
            <div className="absolute inset-0 bg-red-500/90 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300 z-10">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-2 shadow-lg">
                <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12"></path></svg>
              </div>
              <span className="text-white font-bold text-lg tracking-wide">Scan Failed</span>
            </div>
          )}

          {scanStatus === 'duplicate' && (
            <div className="absolute inset-0 bg-yellow-500/90 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300 z-10">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-2 shadow-lg">
                <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
              </div>
              <span className="text-white font-bold text-lg tracking-wide text-center px-4">Already Recorded</span>
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