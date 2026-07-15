import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import TeacherDashboard from './features/teacher/TeacherDashboard';
import StudentPortal from './features/student/StudentPortal';

export default function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
        {/* Temporary Navigation for development */}
        <nav className="bg-blue-600 text-white p-4 shadow-md flex gap-4">
          <div className="font-bold text-xl mr-auto">Attendance Thingy</div>
          <Link to="/teacher" className="hover:underline">Teacher Dashboard</Link>
          <Link to="/student" className="hover:underline">Student Portal</Link>
        </nav>

        <main className="p-6 max-w-7xl mx-auto">
          <Routes>
            <Route path="/" element={<h1 className="text-2xl">Welcome. Please select a portal above.</h1>} />
            <Route path="/teacher/*" element={<TeacherDashboard />} />
            <Route path="/student/*" element={<StudentPortal />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}