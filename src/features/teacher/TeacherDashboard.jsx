import { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../../lib/supabase';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export default function TeacherDashboard() {
  const [activeTab, setActiveTab] = useState('qr'); // 'qr', 'roster', 'setup', 'history'
  const [teacherContext, setTeacherContext] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const [mySubjects, setMySubjects] = useState([]);
  const [myClasses, setMyClasses] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState('');

  const [subjectForm, setSubjectForm] = useState({ name: '', code: '' });
  const [classForm, setClassForm] = useState({ subjectId: '', sectionName: '' });
  const [setupMessage, setSetupMessage] = useState('');

  const [enrolledStudents, setEnrolledStudents] = useState([]);
  const [regForm, setRegForm] = useState({ firstName: '', lastName: '', studentId: '' });
  const [regStatus, setRegStatus] = useState('');

  const [activeSession, setActiveSession] = useState(null);
  const [pastSessions, setPastSessions] = useState([]);
  const [countdown, setCountdown] = useState(30);
  const [currentQrPayload, setCurrentQrPayload] = useState('WAITING_FOR_SESSION');
  const [attendanceLogs, setAttendanceLogs] = useState({});
  const [stats, setStats] = useState({ present: 0, late: 0, notScanned: 0, total: 0 });

  // Custom session scheduling inputs
  const [scheduling, setScheduling] = useState({
    startTime: '',
    lateTime: '',
    endTime: ''
  });

  // Use a ref to keep track of enrolled students for the auto-end timer hook
  const enrolledStudentsRef = useRef([]);
  useEffect(() => {
    enrolledStudentsRef.current = enrolledStudents;
  }, [enrolledStudents]);

  // Use a ref for the active session to avoid stale state in interval functions
  const activeSessionRef = useRef(null);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  // Helper: Get default times for the input boxes (HH:MM format)
  const getFormattedTime = (offsetMinutes = 0) => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + offsetMinutes);
    return d.toTimeString().split(' ')[0].substring(0, 5);
  };

  // Populate default times on component load
  useEffect(() => {
    setScheduling({
      startTime: getFormattedTime(0),
      lateTime: getFormattedTime(10), // Default late threshold: 10 minutes from now
      endTime: getFormattedTime(30)   // Default end time: 30 minutes from now
    });
  }, []);

  // 1. Initialize Teacher
  useEffect(() => {
    async function initializeTeacher() {
      const { data: teacher } = await supabase.from('teachers').select('id').limit(1).single();
      if (teacher) {
        setTeacherContext(teacher);
        await fetchSubjectsAndClasses(teacher.id);
      }
      setIsLoading(false);
    }
    initializeTeacher();
  }, []);

  const fetchSubjectsAndClasses = async (teacherId) => {
    const { data: subjects } = await supabase.from('subjects').select('*').eq('teacher_id', teacherId);
    if (subjects) setMySubjects(subjects);

    const { data: classes } = await supabase.from('classes').select('*, subjects(name, code)').eq('teacher_id', teacherId);
    if (classes) {
      setMyClasses(classes);
      if (classes.length > 0 && !selectedClassId) setSelectedClassId(classes[0].id);
    }
  };

  // 2. Load Class Data (Roster, Active Session, Past Sessions)
  useEffect(() => {
    if (!selectedClassId) return;

    async function loadClassData() {
      const { data: roster } = await supabase
        .from('enrollments')
        .select('id, student_id, students(student_id_number, users(first_name, last_name))')
        .eq('class_id', selectedClassId);
      
      let currentRoster = [];
      if (roster) {
        currentRoster = roster;
        setEnrolledStudents(currentRoster);
      }

      const { data: history } = await supabase
        .from('attendance_sessions')
        .select('*')
        .eq('class_id', selectedClassId)
        .eq('is_active', false)
        .order('start_time', { ascending: false });
      if (history) setPastSessions(history);

      const { data: session } = await supabase
        .from('attendance_sessions')
        .select('*')
        .eq('class_id', selectedClassId)
        .eq('is_active', true)
        .maybeSingle();

      if (session) {
        setActiveSession(session);
        const { data: logs } = await supabase.from('attendance_logs').select('student_id, status').eq('session_id', session.id);
        if (logs) {
          const logMap = {};
          let p = 0, l = 0;
          logs.forEach(log => {
            logMap[log.student_id] = log.status;
            if (log.status === 'PRESENT') p++;
            if (log.status === 'LATE') l++;
          });
          setAttendanceLogs(logMap);
          setStats({ present: p, late: l, notScanned: currentRoster.length - p - l, total: currentRoster.length });
        }
      } else {
        setActiveSession(null);
        setCurrentQrPayload('WAITING_FOR_SESSION');
        setAttendanceLogs({});
        setStats({ present: 0, late: 0, notScanned: currentRoster.length, total: currentRoster.length });
      }
    }
    loadClassData();
  }, [selectedClassId]);

  // 3. Class Management & Registration
  const handleCreateSubject = async (e) => {
    e.preventDefault();
    setSetupMessage('Creating...');
    const { error } = await supabase.from('subjects').insert({ name: subjectForm.name, code: subjectForm.code, teacher_id: teacherContext.id });
    if (!error) { setSubjectForm({ name: '', code: '' }); fetchSubjectsAndClasses(teacherContext.id); setSetupMessage('Success.'); }
    setTimeout(() => setSetupMessage(''), 3000);
  };

  const handleCreateClass = async (e) => {
    e.preventDefault();
    setSetupMessage('Creating...');
    const { error } = await supabase.from('classes').insert({ subject_id: classForm.subjectId, section_name: classForm.sectionName, teacher_id: teacherContext.id });
    if (!error) { setClassForm({ subjectId: '', sectionName: '' }); fetchSubjectsAndClasses(teacherContext.id); setSetupMessage('Success.'); }
    setTimeout(() => setSetupMessage(''), 3000);
  };

  const handleRegisterStudent = async (e) => {
    e.preventDefault();
    if (!selectedClassId) return setRegStatus('Please select a class first.');
    setRegStatus('Registering...');
    try {
      const dummyEmail = `${regForm.studentId.toLowerCase()}@student.local`;
      const { data: userData, error: userError } = await supabase.from('users').insert({ email: dummyEmail, first_name: regForm.firstName, last_name: regForm.lastName, role: 'STUDENT' }).select().single();
      if (userError) throw userError;

      const { data: studentData, error: studentError } = await supabase.from('students').insert({ user_id: userData.id, student_id_number: regForm.studentId }).select().single();
      if (studentError) throw studentError;

      const { error: enrollError } = await supabase.from('enrollments').insert({ student_id: studentData.id, class_id: selectedClassId });
      if (enrollError) throw enrollError;

      setRegStatus('Success.');
      setRegForm({ firstName: '', lastName: '', studentId: '' });
      const newStudent = { id: 'temp', student_id: studentData.id, students: { student_id_number: regForm.studentId, users: { first_name: regForm.firstName, last_name: regForm.lastName } } };
      setEnrolledStudents(prev => [...prev, newStudent]);
      setStats(prev => ({ ...prev, total: prev.total + 1, notScanned: prev.notScanned + 1 }));
    } catch (err) {
      setRegStatus('Error: Student ID might already exist.');
    }
    setTimeout(() => setRegStatus(''), 4000);
  };

  const handleRemoveStudent = async (enrollmentId, studentName) => {
    if (!window.confirm(`Remove ${studentName} from this class?`)) return;
    const { error } = await supabase.from('enrollments').delete().eq('id', enrollmentId);
    if (!error) {
      setEnrolledStudents(prev => prev.filter(s => s.id !== enrollmentId));
      setStats(prev => ({ ...prev, total: prev.total - 1, notScanned: prev.notScanned > 0 ? prev.notScanned - 1 : 0 }));
    }
  };

  // 4. Session Controls, QR Generation & Auto-End Timer
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
    }
  }, []);

  // Helper to parse HH:MM input into standard UTC ISO timestamp
  const parseTimeToISO = (timeString) => {
    if (!timeString) return null;
    const [hours, minutes] = timeString.split(':');
    const d = new Date();
    d.setHours(parseInt(hours, 10));
    d.setMinutes(parseInt(minutes, 10));
    d.setSeconds(0);
    d.setMilliseconds(0);
    return d.toISOString();
  };

  // Reusable core function to cleanly close a session and write absences
  const closeActiveSession = useCallback(async (sessionId, rosterList) => {
    const currentLogs = { ...attendanceLogs };

    // Fetch up-to-date logs right before concluding to avoid race conditions
    const { data: latestLogs } = await supabase
      .from('attendance_logs')
      .select('student_id')
      .eq('session_id', sessionId);

    if (latestLogs) {
      latestLogs.forEach(log => {
        currentLogs[log.student_id] = 'PRESENT';
      });
    }

    // Identify which students are still categorized as "Not Scanned"
    const missingStudents = rosterList.filter(s => !currentLogs[s.student_id]);

    if (missingStudents.length > 0) {
      const absentRecords = missingStudents.map(s => ({
        session_id: sessionId,
        student_id: s.student_id,
        status: 'ABSENT'
      }));

      // Mass insert "ABSENT" status records for outstanding students
      await supabase.from('attendance_logs').insert(absentRecords);
    }

    // Mark the session row as inactive in PostgreSQL
    const { data: closedSession } = await supabase.from('attendance_sessions')
      .update({ is_active: false, end_time: new Date().toISOString() })
      .eq('id', sessionId)
      .select().single();

    if (closedSession) {
      setPastSessions(prev => [closedSession, ...prev]);
    }

    setActiveSession(null);
    setCurrentQrPayload('SESSION_INACTIVE');
    setCountdown(30);
    setAttendanceLogs({});
    setStats(prev => ({ ...prev, present: 0, late: 0, notScanned: prev.total }));
  }, [attendanceLogs]);

  const toggleSession = async () => {
    if (!selectedClassId) return alert("Select a class first.");

    if (!activeSession) {
      // Parse dates from inputs
      const startTime = parseTimeToISO(scheduling.startTime);
      const lateThreshold = parseTimeToISO(scheduling.lateTime);
      const endTime = parseTimeToISO(scheduling.endTime);

      if (new Date(lateThreshold) <= new Date(startTime)) {
        return alert("Late threshold must occur after the start time.");
      }
      if (new Date(endTime) <= new Date(lateThreshold)) {
        return alert("End time must occur after the late threshold.");
      }

      const { data } = await supabase.from('attendance_sessions').insert([
        { 
          class_id: selectedClassId, 
          teacher_id: teacherContext.id, 
          start_time: startTime,
          late_threshold: lateThreshold, 
          end_time: endTime,
          is_active: true 
        }
      ]).select().single();

      if (data) {
        setActiveSession(data);
        generateAndSaveToken(data.id);
        setAttendanceLogs({});
        setStats(prev => ({ ...prev, present: 0, late: 0, notScanned: prev.total }));
      }
    } else {
      await closeActiveSession(activeSession.id, enrolledStudents);
    }
  };

  // Check every second if scheduled session end time has arrived
  useEffect(() => {
    const autoEndCheck = setInterval(() => {
      const current = activeSessionRef.current;
      if (current && current.end_time) {
        const now = new Date();
        const scheduledEnd = new Date(current.end_time);
        
        if (now >= scheduledEnd) {
          console.log("Scheduled session end time reached. Processing automated close.");
          closeActiveSession(current.id, enrolledStudentsRef.current);
        }
      }
    }, 1000);

    return () => clearInterval(autoEndCheck);
  }, [closeActiveSession]);

  useEffect(() => {
    let timerInterval;
    if (activeSession) {
      if (currentQrPayload === 'WAITING_FOR_SESSION') generateAndSaveToken(activeSession.id);
      timerInterval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) { generateAndSaveToken(activeSession.id); return 30; }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerInterval);
  }, [activeSession, generateAndSaveToken, currentQrPayload]);

  useEffect(() => {
    if (!activeSession) return;
    const channel = supabase.channel('live-attendance')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance_logs', filter: `session_id=eq.${activeSession.id}` }, (payload) => {
        setAttendanceLogs(prev => ({ ...prev, [payload.new.student_id]: payload.new.status }));
        setStats(prev => {
          const newStats = { ...prev };
          if (payload.new.status === 'PRESENT') newStats.present += 1;
          if (payload.new.status === 'LATE') newStats.late += 1;
          newStats.notScanned -= 1;
          return newStats;
        });
      }).subscribe();
    return () => supabase.removeChannel(channel);
  }, [activeSession]);

  // 5. PDF Export Generation
  const exportSessionPDF = async (session) => {
    const { data: logs } = await supabase
      .from('attendance_logs')
      .select('status, students(student_id_number, users(first_name, last_name))')
      .eq('session_id', session.id);

    if (!logs) return alert("Failed to fetch logs for PDF.");

    const doc = new jsPDF();
    const classDetails = myClasses.find(c => c.id === session.class_id);
    const dateStr = new Date(session.start_time).toLocaleDateString();
    
    doc.setFontSize(18);
    doc.text(`Attendance Report`, 14, 20);
    
    doc.setFontSize(12);
    doc.text(`Class: ${classDetails.subjects.code} - ${classDetails.section_name}`, 14, 30);
    doc.text(`Date: ${dateStr}`, 14, 37);
    doc.text(`Started: ${new Date(session.start_time).toLocaleTimeString()}`, 14, 44);
    doc.text(`Late After: ${new Date(session.late_threshold).toLocaleTimeString()}`, 14, 51);
    if (session.end_time) {
      doc.text(`Session Concluded: ${new Date(session.end_time).toLocaleTimeString()}`, 14, 58);
    }

    const tableData = logs.map(log => [
      `${log.students.users.first_name} ${log.students.users.last_name}`,
      log.students.student_id_number,
      log.status
    ]);

    autoTable(doc, {
      startY: 68,
      head: [['Student Name', 'Student ID', 'Status']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [37, 99, 235] }
    });

    doc.save(`Attendance_${classDetails.subjects.code}_${dateStr.replace(/\//g, '-')}.pdf`);
  };

  if (isLoading) return <div className="p-8">Loading dashboard...</div>;

  const currentClassDetails = myClasses.find(c => c.id === selectedClassId);

  return (
    <div className="flex flex-col gap-6">
      
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Teacher Dashboard</h1>
          <p className="text-sm text-gray-500">Manage your classes and attendance</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm font-semibold text-gray-700">Active Class:</label>
          <select value={selectedClassId} onChange={(e) => setSelectedClassId(e.target.value)} disabled={activeSession !== null} className="px-4 py-2 border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">
            {myClasses.length === 0 && <option value="">No Classes Created</option>}
            {myClasses.map(cls => <option key={cls.id} value={cls.id}>{cls.subjects.code} - {cls.section_name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex border-b border-gray-200">
        <button onClick={() => setActiveTab('qr')} className={`px-6 py-3 font-semibold ${activeTab === 'qr' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}>Live Scanner</button>
        <button onClick={() => setActiveTab('roster')} className={`px-6 py-3 font-semibold ${activeTab === 'roster' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}>Roster</button>
        <button onClick={() => setActiveTab('history')} className={`px-6 py-3 font-semibold ${activeTab === 'history' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}>Session History</button>
        <button onClick={() => setActiveTab('setup')} className={`px-6 py-3 font-semibold ${activeTab === 'setup' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}>Class Management</button>
      </div>

      {/* TAB 1: LIVE QR */}
      {activeTab === 'qr' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-300">
          <div className="col-span-2 bg-white p-8 rounded-xl shadow-sm border border-gray-100 flex flex-col items-center justify-center min-h-[500px]">
            {selectedClassId ? (
              <>
                <div className="w-full flex justify-between items-start mb-8">
                  <div>
                    <h2 className="text-2xl font-bold text-gray-800">Active Session</h2>
                    <p className="text-sm font-medium text-gray-800 mt-1">{currentClassDetails?.subjects.name} ({currentClassDetails?.section_name})</p>
                    {activeSession && (
                      <div className="text-sm text-gray-500 mt-2 bg-gray-50 p-3 rounded-lg border border-gray-200">
                        <span className="font-semibold text-gray-700">Date:</span> {new Date(activeSession.start_time).toLocaleDateString()} <br />
                        <span className="font-semibold text-gray-700">Started:</span> {new Date(activeSession.start_time).toLocaleTimeString()} <br />
                        <span className="font-semibold text-gray-700">Late Threshold:</span> {new Date(activeSession.late_threshold).toLocaleTimeString()} <br />
                        <span className="font-semibold text-gray-700">Scheduled End:</span> {new Date(activeSession.end_time).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                  <span className={`px-4 py-1 rounded-full text-sm font-bold ${activeSession ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {activeSession ? 'LIVE' : 'STANDBY'}
                  </span>
                </div>

                {/* Scheduling Parameters Inputs (Visible only when standby) */}
                {!activeSession && (
                  <div className="w-full max-w-md bg-gray-50 p-4 rounded-xl border border-gray-200 mb-8 space-y-3">
                    <h4 className="text-sm font-bold text-gray-700">Schedule Session Times</h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Start Time</label>
                        <input type="time" value={scheduling.startTime} onChange={e => setScheduling({...scheduling, startTime: e.target.value})} className="w-full px-2 py-1 text-sm border rounded bg-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Late After</label>
                        <input type="time" value={scheduling.lateTime} onChange={e => setScheduling({...scheduling, lateTime: e.target.value})} className="w-full px-2 py-1 text-sm border rounded bg-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Auto End</label>
                        <input type="time" value={scheduling.endTime} onChange={e => setScheduling({...scheduling, endTime: e.target.value})} className="w-full px-2 py-1 text-sm border rounded bg-white" />
                      </div>
                    </div>
                  </div>
                )}

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
                    <span className="text-gray-400 font-medium">Configure times & start session</span>
                  )}
                </div>

                <div className="mt-8 flex gap-4 w-full max-w-md">
                  {!activeSession ? (
                    <button onClick={toggleSession} className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition shadow-md">
                      Start Attendance Session
                    </button>
                  ) : (
                    <button onClick={toggleSession} className="flex-1 py-3 bg-red-50 text-red-600 border border-red-200 rounded-lg font-bold hover:bg-red-100 transition shadow-md">
                      End Session & Log Absences
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="text-gray-500 font-medium">Please create and select a class to start a session.</div>
            )}
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
                <div className="flex justify-between items-center p-3 bg-gray-50 text-gray-600 rounded-lg border border-gray-200">
                  <span className="font-semibold">Not Scanned</span>
                  <span className="font-bold text-2xl">{stats.notScanned}</span>
                </div>
                <div className="mt-4 pt-4 border-t">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Scan Completion</span>
                    <span>{stats.total > 0 ? Math.round(((stats.present + stats.late) / stats.total) * 100) : 0}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-blue-600 h-2 rounded-full transition-all duration-500" style={{ width: `${stats.total > 0 ? ((stats.present + stats.late) / stats.total) * 100 : 0}%` }}></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: ROSTER */}
      {activeTab === 'roster' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in duration-300">
          <div className="col-span-1 bg-white p-6 rounded-xl shadow-sm border border-gray-100 h-fit">
            <h3 className="text-lg font-bold mb-4 text-gray-800 border-b pb-2">Register Student to Class</h3>
            <form onSubmit={handleRegisterStudent} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                <input type="text" required value={regForm.firstName} onChange={e => setRegForm({...regForm, firstName: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                <input type="text" required value={regForm.lastName} onChange={e => setRegForm({...regForm, lastName: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Student ID</label>
                <input type="text" required value={regForm.studentId} onChange={e => setRegForm({...regForm, studentId: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md" />
              </div>
              <button type="submit" disabled={!selectedClassId} className="w-full bg-blue-600 text-white font-bold py-2 rounded-md hover:bg-blue-700 transition disabled:bg-blue-300">Add Student</button>
              {regStatus && <p className="text-sm mt-2 text-center text-gray-600">{regStatus}</p>}
            </form>
          </div>

          <div className="col-span-2 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-lg font-bold text-gray-800">Class Roster</h3>
              <span className="text-sm text-gray-500">Total Enrolled: {enrolledStudents.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-sm uppercase tracking-wider">
                    <th className="p-4 font-semibold border-b">Name</th>
                    <th className="p-4 font-semibold border-b">Student ID</th>
                    <th className="p-4 font-semibold border-b">Current Status</th>
                    <th className="p-4 font-semibold border-b text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {enrolledStudents.map((enrollment) => {
                    const student = enrollment.students;
                    const status = activeSession ? (attendanceLogs[enrollment.student_id] || 'NOT SCANNED') : 'STANDBY';
                    
                    let statusColor = 'text-gray-500 bg-gray-50';
                    if (status === 'PRESENT') statusColor = 'text-green-700 bg-green-50 font-bold';
                    if (status === 'LATE') statusColor = 'text-yellow-700 bg-yellow-50 font-bold';

                    return (
                      <tr key={enrollment.student_id} className="hover:bg-gray-50">
                        <td className="p-4 text-gray-800 font-medium">{student.users.first_name} {student.users.last_name}</td>
                        <td className="p-4 text-gray-500 text-sm">{student.student_id_number}</td>
                        <td className="p-4"><span className={`px-3 py-1 rounded-full text-xs tracking-wide ${statusColor}`}>{status}</span></td>
                        <td className="p-4 text-right">
                          <button onClick={() => handleRemoveStudent(enrollment.id, student.users.first_name)} className="text-red-500 hover:text-red-700 text-sm font-semibold transition">
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: HISTORY */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden animate-in fade-in duration-300">
          <div className="p-6 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-800">Past Sessions</h3>
            <p className="text-sm text-gray-500">View logs and export attendance reports</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-sm uppercase tracking-wider">
                  <th className="p-4 font-semibold border-b">Date</th>
                  <th className="p-4 font-semibold border-b">Start Time</th>
                  <th className="p-4 font-semibold border-b">End Time</th>
                  <th className="p-4 font-semibold border-b text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pastSessions.map((session) => (
                  <tr key={session.id} className="hover:bg-gray-50">
                    <td className="p-4 text-gray-800 font-medium">{new Date(session.start_time).toLocaleDateString()}</td>
                    <td className="p-4 text-gray-500 text-sm">{new Date(session.start_time).toLocaleTimeString()}</td>
                    <td className="p-4 text-gray-500 text-sm">{session.end_time ? new Date(session.end_time).toLocaleTimeString() : 'Manual Close Required'}</td>
                    <td className="p-4 text-right">
                      <button 
                        onClick={() => exportSessionPDF(session)}
                        className="bg-blue-50 text-blue-600 px-4 py-2 rounded-lg font-semibold hover:bg-blue-100 transition border border-blue-200 text-sm"
                      >
                        Download PDF
                      </button>
                    </td>
                  </tr>
                ))}
                {pastSessions.length === 0 && (
                  <tr>
                    <td colSpan="4" className="p-8 text-center text-gray-400">No past sessions found for this class.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: CLASS MANAGEMENT */}
      {activeTab === 'setup' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-in fade-in duration-300">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-bold mb-4 text-gray-800 border-b pb-2">1. Create a Subject</h3>
            <form onSubmit={handleCreateSubject} className="space-y-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Subject Name</label><input type="text" required value={subjectForm.name} onChange={e => setSubjectForm({...subjectForm, name: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Subject Code</label><input type="text" required value={subjectForm.code} onChange={e => setSubjectForm({...subjectForm, code: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md uppercase" /></div>
              <button type="submit" className="w-full bg-indigo-600 text-white font-bold py-2 rounded-md hover:bg-indigo-700 transition">Create Subject</button>
            </form>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-bold mb-4 text-gray-800 border-b pb-2">2. Create a Class / Section</h3>
            <form onSubmit={handleCreateClass} className="space-y-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Select Subject</label><select required value={classForm.subjectId} onChange={e => setClassForm({...classForm, subjectId: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md"><option value="" disabled>Choose a subject...</option>{mySubjects.map(sub => <option key={sub.id} value={sub.id}>{sub.code} - {sub.name}</option>)}</select></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Section Name</label><input type="text" required value={classForm.sectionName} onChange={e => setClassForm({...classForm, sectionName: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-md" /></div>
              <button type="submit" disabled={mySubjects.length === 0} className="w-full bg-blue-600 text-white font-bold py-2 rounded-md hover:bg-blue-700 transition disabled:bg-blue-300">Create Class</button>
            </form>
            {setupMessage && <p className="text-sm mt-4 text-center text-gray-600 font-medium">{setupMessage}</p>}
          </div>
        </div>
      )}

    </div>
  );
}