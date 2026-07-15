import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../../lib/supabase';

export default function TeacherDashboard() {
  const [activeSession, setActiveSession] = useState(null);
  const [testContext, setTestContext] = useState({ classId: null, teacherId: null });
  const [countdown, setCountdown] = useState(30);
  const [currentQrPayload, setCurrentQrPayload] = useState('WAITING_FOR_SESSION');
  const [stats, setStats] = useState({ present: 0, late: 0, absent: 45 });
  const [isLoading, setIsLoading] = useState(true);

  // 1. Fetch class context AND check for an existing active session
  useEffect(() => {
    async function initializeDashboard() {
      const { data: classData, error: classError } = await supabase
        .from('classes')
        .select('id, teacher_id')
        .limit(1)
        .single();

      if (classData) {
        setTestContext({ classId: classData.id, teacherId: classData.teacher_id });

        // RECOVERY LOGIC: Check if a session was left running
        const { data: existingSession } = await supabase
          .from('attendance_sessions')
          .select('*')
          .eq('class_id', classData.id)
          .eq('is_active', true)
          .maybeSingle();

        if (existingSession) {
          setActiveSession(existingSession);
          
          // Count historical scans from before the refresh
          const { data: logs } = await supabase
            .from('attendance_logs')
            .select('status')
            .eq('session_id', existingSession.id);

          if (logs) {
            const presentCount = logs.filter(l => l.status === 'PRESENT').length;
            const lateCount = logs.filter(l => l.status === 'LATE').length;
            setStats({
              present: presentCount,
              late: lateCount,
              absent: 45 - presentCount - lateCount
            });
          }
        }
      } else {
        console.error("No test class found.", classError);
      }
      setIsLoading(false);
    }
    initializeDashboard();
  }, []);

  // 2. Generate and OVERWRITE the secure QR Token in Postgres
  const generateAndSaveToken = useCallback(async (sessionId) => {
    const timestamp = Date.now();
    const nonce = Math.random().toString(36).substring(2, 10);
    const payload = `ATT-${timestamp}-${nonce}`;
    
    const expiresAt = new Date(timestamp + 30000).toISOString();

    const { error } = await supabase.from('qr_tokens').upsert([
      { session_id: sessionId, payload: payload, nonce: nonce, expires_at: expiresAt }
    ], { onConflict: 'session_id' });

    if (!error) {
      setCurrentQrPayload(payload);
      setCountdown(30);
    } else {
      console.error("Failed to save QR token to DB:", error);
    }
  }, []);

  // 3. Start or End the Session
  const toggleSession = async () => {
    if (!activeSession) {
      const lateTime = new Date();
      lateTime.setMinutes(lateTime.getMinutes() + 5);

      const { data, error } = await supabase.from('attendance_sessions').insert([
        { 
          class_id: testContext.classId, 
          teacher_id: testContext.teacherId,
          late_threshold: lateTime.toISOString(),
          is_active: true
        }
      ]).select().single();

      if (data) {
        setActiveSession(data);
        generateAndSaveToken(data.id);
        setStats({ present: 0, late: 0, absent: 45 });
      } else {
        console.error("Failed to start session:", error);
      }
    } else {
      await supabase.from('attendance_sessions')
        .update({ is_active: false, end_time: new Date().toISOString() })
        .eq('id', activeSession.id);
      
      setActiveSession(null);
      setCurrentQrPayload('SESSION_INACTIVE');
      setCountdown(30);
    }
  };

  // 4. Handle the 30-second visual rotation
  useEffect(() => {
    let timerInterval;
    if (activeSession) {
      // Immediately generate a token if we just recovered the session on refresh
      if (currentQrPayload === 'WAITING_FOR_SESSION') {
        generateAndSaveToken(activeSession.id);
      }

      timerInterval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            generateAndSaveToken(activeSession.id);
            return 30;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerInterval);
  }, [activeSession, generateAndSaveToken, currentQrPayload]);

  // 5. Supabase Realtime WebSockets for Live Stats
  useEffect(() => {
    if (!activeSession) return;

    const attendanceChannel = supabase.channel('live-attendance')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'attendance_logs', filter: `session_id=eq.${activeSession.id}` },
        (payload) => {
          setStats((prev) => {
            const newStats = { ...prev };
            if (payload.new.status === 'PRESENT') newStats.present += 1;
            if (payload.new.status === 'LATE') newStats.late += 1;
            newStats.absent -= 1;
            return newStats;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(attendanceChannel);
    };
  }, [activeSession]);

  if (isLoading) return <div className="p-8">Loading database connection...</div>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="col-span-2 bg-white p-8 rounded-xl shadow-sm border border-gray-100 flex flex-col items-center justify-center min-h-[500px]">
        <div className="w-full flex justify-between items-center mb-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Active Session</h2>
            <p className="text-sm text-gray-500">CS101 - Introduction to Programming</p>
          </div>
          <span className={`px-4 py-1 rounded-full text-sm font-bold ${activeSession ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            {activeSession ? 'LIVE' : 'STANDBY'}
          </span>
        </div>

        <div className={`w-80 h-80 border-4 flex flex-col items-center justify-center rounded-xl transition-all duration-300 ${activeSession ? 'border-blue-500 bg-white shadow-[0_0_30px_rgba(59,130,246,0.15)]' : 'border-dashed border-gray-300 bg-gray-50'}`}>
          {activeSession ? (
            <div className="flex flex-col items-center justify-center">
              <div className="p-4 bg-white rounded-xl shadow-sm border border-gray-100 mb-4">
                <QRCodeSVG value={currentQrPayload} size={200} level="H" includeMargin={false} />
              </div>
              <div className="text-3xl font-bold text-blue-600 tabular-nums">{countdown}s</div>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-wider font-semibold">Until Rotation</p>
            </div>
          ) : (
            <span className="text-gray-400 font-medium">Start session to reveal QR</span>
          )}
        </div>

        <div className="mt-8 flex gap-4 w-full max-w-md">
          {!activeSession ? (
            <button onClick={toggleSession} className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition shadow-md">
              Start Attendance Session
            </button>
          ) : (
            <button onClick={toggleSession} className="flex-1 py-3 bg-red-50 text-red-600 border border-red-200 rounded-lg font-bold hover:bg-red-100 transition">
              End Session
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-lg font-bold mb-4 text-gray-800 border-b pb-2">Live Roster Status</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center p-3 bg-green-50 text-green-700 rounded-lg border border-green-100">
              <span className="font-semibold">Present</span>
              <span className="font-bold text-2xl">{stats.present}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-yellow-50 text-yellow-700 rounded-lg border border-yellow-100">
              <span className="font-semibold">Late</span>
              <span className="font-bold text-2xl">{stats.late}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-red-50 text-red-700 rounded-lg border border-red-100">
              <span className="font-semibold">Absent</span>
              <span className="font-bold text-2xl">{stats.absent}</span>
            </div>
            
            <div className="mt-4 pt-4 border-t">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Completion</span>
                <span>{Math.round(((stats.present + stats.late) / 45) * 100) || 0}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div className="bg-blue-600 h-2 rounded-full transition-all duration-500" style={{ width: `${((stats.present + stats.late) / 45) * 100}%` }}></div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex-1">
          <h3 className="text-lg font-bold mb-4 text-gray-800 border-b pb-2">Quick Actions</h3>
          <div className="space-y-2">
            <button className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md transition border border-transparent hover:border-gray-200">
              View Detailed Student List
            </button>
            <button className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md transition border border-transparent hover:border-gray-200">
              Manual Attendance Override
            </button>
            <button className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md transition border border-transparent hover:border-gray-200">
              Export Session to CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}